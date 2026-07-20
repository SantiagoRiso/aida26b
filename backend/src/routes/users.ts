import type express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from '../auth';
import { isRole } from '../../../shared/src/types/roles';
import { guardRoute } from '../helpers';
import { sendData, sendError } from '../status_messages';
import { readPassword } from '../auth';
import type { AuditWriter } from '../audit';
import { authenticatedUser } from '../session';
import { requireBusinessContext } from './business-context';
import { withTransaction } from '../db/core';
import { DbError } from '../db/errors';
import {
  insertUser,
  deactivateUser,
  resetUserPassword,
  deleteUserSessions,
  insertContactOnlyClient,
  findContactOnlyClient,
  enableClientLogin,
} from '../db/users';
import { ADMIN_USER_PATTERNS } from '../../../shared/src/ssot/api-paths';
import type { CreatedUserResult, EnabledLoginResult } from '../../../shared/src/ssot/contracts/users';
import { EMAIL_PATTERN } from '../../../shared/src/ssot/domain/people';

const EMAIL_RE = new RegExp(EMAIL_PATTERN);

// eslint-disable-next-line no-restricted-syntax -- catch-boundary: narrows an unverified thrown error into DbError
function isUniqueViolation(error: unknown): error is DbError {
  return error instanceof DbError && error.pgCode === '23505';
}

// Single unique-violation → 409 responder. The per-business DNI constraint is shared by
// every user write, so it is named here; the fallback names the field the caller was
// inserting (email vs username) so the form can react to the right input.
// Anything else rethrows for guardRoute to map (unexpected DbError → mapped code, else 500).
// eslint-disable-next-line no-restricted-syntax -- Catch-boundary value is narrowed before any database fields are read.
function sendUniqueConflict(res: express.Response, error: unknown, fallbackMessage: string) {
  if (!isUniqueViolation(error)) throw error;
  const message =
    error.constraint === 'uq_users_business_dni' ? 'DNI already exists' : fallbackMessage;
  return sendError(res, 409, 'conflict', message);
}

type CreateUserInput = {
  username: string;
  emailRaw: string | null;
  password: string | null;
  role: string;
  displayName: string;
  dni: string | null;
};

// Contact-only client (walk-in / phone booking): no username or password supplied.
// Bookable immediately; login is enabled later via /enable-login.
async function createContactOnlyClient(
  pool: Pool,
  audit: AuditWriter,
  req: express.Request,
  res: express.Response,
  input: CreateUserInput,
) {
  const { emailRaw, displayName, dni, role } = input;

  const businessId = requireBusinessContext(req, res);
  if (businessId == null) return;

  if (!displayName) {
    return sendError(res, 400, 'invalid_request', 'A valid display name is required', { detail: { key: 'displayNameRequired' } });
  }

  // A walk-in may have no email at all; anything supplied still has to be a real address.
  if (emailRaw !== null && !EMAIL_RE.test(emailRaw)) {
    return sendError(res, 400, 'invalid_request', 'A valid email is required', { detail: { key: 'emailFormat' } });
  }

  try {
    const newUserId = await withTransaction(pool, async (tx) => {
      const inserted = await insertContactOnlyClient(tx, {
        email: emailRaw, displayName, dni, businessId,
      });
      return Number(inserted.id);
    });

    await audit(req, 'user_created', 'success', { user_id: newUserId, role });

    return sendData(res, { id: newUserId, role } satisfies CreatedUserResult, 201);
  } catch (error) {
    return sendUniqueConflict(res, error, 'Email already exists');
  }
}

async function createCredentialedUser(
  pool: Pool,
  audit: AuditWriter,
  req: express.Request,
  res: express.Response,
  input: CreateUserInput,
) {
  const { username, emailRaw, password, role, displayName, dni } = input;

  if (!username || !password || !isRole(role)) {
    return sendError(res, 400, 'invalid_request', 'Valid username, password and role are required', { detail: { key: 'usernamePasswordRoleRequired' } });
  }

  // A null business_id means "see/act across all businesses"; stamping it onto a new
  // user would mint a cross-tenant account. User creation requires a concrete business.
  const businessId = requireBusinessContext(req, res);
  if (businessId == null) return;
  // Only clients may go without an email; staff accounts must always carry one, so a missing
  // address falls back to a placeholder rather than tripping the users_client_or_email check.
  const email = emailRaw ?? (role === 'Client' ? null : `${username}@noemail.local`);
  const { passwordHash, passwordSalt } = await auth.hashPassword(password);

  try {
    // All person attributes (display_name, dni, phone, bio, notes) live on auth.users directly.
    const newUserId = await withTransaction(pool, async (tx) => {
      const inserted = await insertUser(tx, {
        username, email, displayName, dni,
        passwordHash, passwordSalt, role, businessId,
      });
      return Number(inserted.id);
    });

    await audit(req, 'user_created', 'success', { user_id: newUserId, role });

    return sendData(res, { id: newUserId, username, role } satisfies CreatedUserResult, 201);
  } catch (error) {
    return sendUniqueConflict(res, error, 'Username already exists');
  }
}

export function mountUserAdminRoutes(
  app: express.Application,
  pool: Pool,
  deps: {
    audit: AuditWriter;
    requireAuth: RequestHandler;
    requirePasswordReady: RequestHandler;
    requireAdmin: RequestHandler;
  },
) {
  const { audit, requireAuth, requirePasswordReady, requireAdmin } = deps;

  // Role is immutable after creation — change requires deactivate + recreate.
  // business_id comes from the caller's session; any body-supplied value is ignored.
  // Admins create any role; Professionals and Receptionists may only register Clients.
  app.post(
    ADMIN_USER_PATTERNS.create,
    requireAuth,
    requirePasswordReady,
    guardRoute(async (req, res) => {
      const username =
        typeof req.body.username === 'string' ? req.body.username.trim() : '';

      const emailRaw =
        typeof req.body.email === 'string' && req.body.email.trim() ? req.body.email.trim() : null;

      const password = readPassword(req.body.password);
      const role = req.body.role;
      const displayName =
        typeof req.body.display_name === 'string' && req.body.display_name.trim()
          ? req.body.display_name.trim()
          : username;

      const dni =
        typeof req.body.dni === 'string' && req.body.dni.trim() ? req.body.dni.trim() : null;

      const sessionUser = authenticatedUser(req);

      const mayCreate =
        sessionUser.role === 'Admin' ||
        ((sessionUser.role === 'Professional' || sessionUser.role === 'Receptionist') &&
          role === 'Client');

      if (!mayCreate) {
        await audit(req, 'permission_denied', 'denied', { path: req.path, method: req.method });
        return sendError(res, 403, 'forbidden', 'Forbidden', { detail: { key: 'insufficientRole' } });
      }

      const input: CreateUserInput = { username, emailRaw, password, role, displayName, dni };

      if (role === 'Client' && !username && !password) {
        return createContactOnlyClient(pool, audit, req, res, input);
      }

      return createCredentialedUser(pool, audit, req, res, input);
    }),
  );

  // Role is immutable — change requires deactivate + recreate.
  app.post(
    ADMIN_USER_PATTERNS.deactivate,
    requireAuth,
    requirePasswordReady,
    requireAdmin,
    guardRoute(async (req, res) => {
      const userId = Number(req.params.id);
      const sessionUser = authenticatedUser(req);

      if (!Number.isInteger(userId)) {
        return sendError(res, 400, 'invalid_request', 'Valid user id is required', { detail: { key: 'invalidId' } });
      }

      const businessId = requireBusinessContext(req, res);
      if (businessId == null) return;

      // An admin deactivating themselves would lock the business out of its own admin surface.
      if (userId === sessionUser.id) {
        return sendError(res, 400, 'invalid_request', 'You cannot deactivate your own account', { detail: { key: 'cannotDeactivateSelf' } });
      }

      const deactivated = await deactivateUser(pool, {
        userId,
        businessId,
        actorId: sessionUser.id,
      });

      if (!deactivated) {
        return sendError(res, 404, 'not_found', 'User not found', { detail: { key: 'userNotFound' } });
      }

      await deleteUserSessions(pool, userId);

      await audit(req, 'user_deactivated', 'success', { user_id: userId });

      return sendData(res, { user: deactivated });
    }),
  );

  app.post(
    ADMIN_USER_PATTERNS.resetPassword,
    requireAuth,
    requirePasswordReady,
    requireAdmin,
    guardRoute(async (req, res) => {
      const userId = Number(req.params.id);
      const password = readPassword(req.body.password);
      const sessionUser = authenticatedUser(req);

      if (!Number.isInteger(userId) || !password) {
        return sendError(res, 400, 'invalid_request', 'Valid user id and password are required', { detail: { key: 'userIdAndPasswordRequired' } });
      }

      const businessId = requireBusinessContext(req, res);
      if (businessId == null) return;

      // A self-reset forces must_change_password on the admin and kills their sessions,
      // locking them out; admins change their own password via /auth/change-password.
      if (userId === sessionUser.id) {
        return sendError(res, 400, 'invalid_request', 'You cannot reset your own password here; use change password instead', { detail: { key: 'cannotResetOwnPassword' } });
      }

      const { passwordHash, passwordSalt } = await auth.hashPassword(password);

      // Scope by the admin's business so a tenant admin can only reset their own
      // users' passwords, never another business's accounts.
      const reset = await resetUserPassword(pool, {
        userId,
        businessId,
        passwordHash,
        passwordSalt,
      });

      if (!reset) {
        return sendError(res, 404, 'not_found', 'User not found', { detail: { key: 'userNotFound' } });
      }

      await deleteUserSessions(pool, userId);

      await audit(req, 'password_reset', 'success', { user_id: userId });

      return sendData(res, { user: reset });
    }),
  );

  // "Enable login" turns a contact-only client (username IS NULL) into a client who can log
  // in. Same authz as creating a Client: Admin, or Professional/Receptionist for their own business.
  app.post(
    ADMIN_USER_PATTERNS.enableLogin,
    requireAuth,
    requirePasswordReady,
    guardRoute(async (req, res) => {
      const userId = Number(req.params.id);
      const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
      const emailRaw =
        typeof req.body.email === 'string' && req.body.email.trim() ? req.body.email.trim() : null;
      const password = readPassword(req.body.password);
      const sessionUser = authenticatedUser(req);

      const mayManage =
        sessionUser.role === 'Admin' || sessionUser.role === 'Professional' || sessionUser.role === 'Receptionist';

      if (!mayManage) {
        await audit(req, 'permission_denied', 'denied', { path: req.path, method: req.method });
        return sendError(res, 403, 'forbidden', 'Forbidden', { detail: { key: 'insufficientRole' } });
      }

      if (!Number.isInteger(userId) || !username || !password) {
        return sendError(res, 400, 'invalid_request', 'Valid user id, username and password are required', { detail: { key: 'userCredentialsRequired' } });
      }

      const businessId = requireBusinessContext(req, res);
      if (businessId == null) return;

      const target = await findContactOnlyClient(pool, { userId, businessId });
      if (!target) {
        return sendError(res, 404, 'not_found', 'Client not found', { detail: { key: 'clientNotFound' } });
      }

      // A client who can log in is reachable by email; one who was recorded without an address
      // has to supply it now.
      if (emailRaw !== null && !EMAIL_RE.test(emailRaw)) {
        return sendError(res, 400, 'invalid_request', 'A valid email is required', { detail: { key: 'emailFormat' } });
      }
      if (target.email === null && emailRaw === null) {
        return sendError(res, 400, 'invalid_request', 'A valid email is required', { detail: { key: 'emailFormat' } });
      }

      const { passwordHash, passwordSalt } = await auth.hashPassword(password);

      try {
        const enabled = await enableClientLogin(pool, {
          userId,
          businessId,
          username,
          email: emailRaw,
          passwordHash,
          passwordSalt,
        });

        if (!enabled) {
          return sendError(res, 404, 'not_found', 'Client not found', { detail: { key: 'clientNotFound' } });
        }

        await audit(req, 'login_enabled', 'success', { user_id: userId });

        return sendData(res, { id: enabled.id, username: enabled.username } satisfies EnabledLoginResult);
      } catch (error) {
        return sendUniqueConflict(res, error, 'Username already exists');
      }
    }),
  );
}
