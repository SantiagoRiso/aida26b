import type express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from '../auth';
import { isRole } from '../../../shared/src/types/roles';
import { guardRoute } from '../helpers';
import { sendData, sendError } from '../status_messages';
import { readPassword, MIN_PASSWORD_LENGTH } from '../auth';
import { isPasswordTooShort, PASSWORD_TOO_SHORT_KEY } from '../../../shared/src/ssot/domain/people';
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
import type { UserAdminScope } from '../db/users';
import { getBusinessSettings } from '../db/businesses';
import { ADMIN_USER_PATTERNS } from '../../../shared/src/ssot/api-paths';
import type { CreatedUserResult, EnabledLoginResult } from '../../../shared/src/ssot/contracts/users';
import { EMAIL_PATTERN } from '../../../shared/src/ssot/domain/people';
import { USER_IDENTITY_CONSTRAINT_DETAIL_KEYS } from '../../../shared/src/ssot/domain/constraint-messages';

const EMAIL_RE = new RegExp(EMAIL_PATTERN);

// eslint-disable-next-line no-restricted-syntax -- catch-boundary: narrows an unverified thrown error into DbError
function isUniqueViolation(error: unknown): error is DbError {
  return error instanceof DbError && error.pgCode === '23505';
}

// English log prose per identity constraint; the client never reads this — it resolves the
// localized message from `detail.key` below (USER_IDENTITY_CONSTRAINT_DETAIL_KEYS, the SSoT map
// shared with the drift guard). Kept off the global httpForDbError map deliberately: these three
// are the only unique constraints allowed a precise message on this admin/staff-only surface — see
// constraint-messages.ts for why the self-service email/DNI paths must stay generic.
const IDENTITY_CONSTRAINT_LOG_MESSAGE: Readonly<Record<string, string>> = Object.freeze({
  users_username_key: 'Username already exists',
  users_email_unique: 'Email already exists',
  uq_users_business_dni: 'DNI already exists',
});

// Single unique-violation → 409 responder for the admin/staff user-creation surfaces
// (POST /api/admin/users, POST /api/admin/users/:id/enable-login). Anything else rethrows for
// guardRoute to map (unexpected DbError → mapped code, else 500).
// eslint-disable-next-line no-restricted-syntax -- Catch-boundary value is narrowed before any database fields are read.
function sendUniqueConflict(res: express.Response, error: unknown, fallbackMessage: string) {
  if (!isUniqueViolation(error)) throw error;
  const constraint = error.constraint;
  const message = (constraint && IDENTITY_CONSTRAINT_LOG_MESSAGE[constraint]) || fallbackMessage;
  const key = constraint ? USER_IDENTITY_CONSTRAINT_DETAIL_KEYS[constraint] : undefined;
  return sendError(res, 409, 'conflict', message, key ? { detail: { key } } : {});
}

type CreateUserInput = {
  username: string;
  emailRaw: string | null;
  password: string | null;
  // The value exactly as submitted, kept only so a too-short password can be named as such.
  rawPassword: string;
  role: string;
  displayName: string;
  dni: string | null;
  businessId: number;
};

// These events are attributed to the tenant they affect (the target's), not the actor's: a
// super-admin has no business of their own, and an event filed under nothing at all leaves the
// action untraceable. Null only for a target who is themselves tenantless.
function numericBusiness(businessId: string | null): number | null {
  return businessId == null ? null : Number(businessId);
}

function isSuperAdmin(user: { role: string; business_id: number | null }): boolean {
  return user.role === 'Admin' && user.business_id == null;
}

// Which tenants the caller may administer users in. The super-admin exists to act across tenants,
// so the reach is widened for that role alone; everyone else is confined to their session's
// business and is refused outright without one.
function userAdminScope(req: express.Request, res: express.Response): UserAdminScope | null {
  if (isSuperAdmin(authenticatedUser(req))) return { kind: 'all' };
  const businessId = requireBusinessContext(req, res);
  if (businessId == null) return null;
  return { kind: 'tenant', businessId };
}

// Creation has no target row to read a tenant off, so a super-admin names it explicitly. For every
// other caller the tenant is their own and naming one is refused rather than honoured, so no
// account can be minted outside the caller's business. Null means a response was already sent.
async function resolveCreationBusiness(
  pool: Pool,
  req: express.Request,
  res: express.Response,
): Promise<number | null> {
  const requested = req.body.target_business_id;

  if (!isSuperAdmin(authenticatedUser(req))) {
    if (requested !== undefined) {
      sendError(res, 400, 'invalid_request', 'You cannot create users in another business', { detail: { key: 'targetBusinessNotAllowed' } });
      return null;
    }
    return requireBusinessContext(req, res);
  }

  const businessId = Number(requested);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    sendError(res, 400, 'invalid_request', 'A target business is required', { detail: { key: 'targetBusinessRequired' } });
    return null;
  }

  // An unknown tenant would otherwise be caught only by the FK, after the rest of the work.
  if (!(await getBusinessSettings(pool, businessId))) {
    sendError(res, 400, 'invalid_request', 'Unknown business', { detail: { key: 'targetBusinessNotFound' } });
    return null;
  }

  return businessId;
}

// Contact-only client (walk-in / phone booking): no username or password supplied.
// Bookable immediately; login is enabled later via /enable-login.
async function createContactOnlyClient(
  pool: Pool,
  audit: AuditWriter,
  req: express.Request,
  res: express.Response,
  input: CreateUserInput,
) {
  const { emailRaw, displayName, dni, role, businessId } = input;

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

    await audit(req, 'user_created', 'success', { entity_type: 'auth.users', entity_id: newUserId, user_id: newUserId, role }, { businessId });

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
  const { username, emailRaw, password, rawPassword, role, displayName, dni, businessId } = input;

  // readPassword returns null both for an absent password and for one under the minimum, so the
  // raw value is tested first: someone who typed five characters must be told the length, not told
  // to fill in the box they just filled.
  if (isPasswordTooShort(rawPassword)) {
    return sendError(res, 400, 'invalid_request', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      detail: { key: PASSWORD_TOO_SHORT_KEY, params: { min: String(MIN_PASSWORD_LENGTH) } },
    });
  }

  if (!username || !password || !isRole(role)) {
    return sendError(res, 400, 'invalid_request', 'Valid username, password and role are required', { detail: { key: 'usernamePasswordRoleRequired' } });
  }

  // Email is the login identity: an account created with credentials has to be reachable at one.
  // Only a contact-only client may go without, and it is getting credentials here.
  if (role === 'Client' && emailRaw === null) {
    return sendError(res, 400, 'invalid_request', 'A valid email is required', { detail: { key: 'emailFormat' } });
  }

  // Staff are never registered through the email-bearing client form, so a missing address
  // falls back to a placeholder.
  const email = emailRaw ?? `${username}@noemail.local`;
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

    await audit(req, 'user_created', 'success', { entity_type: 'auth.users', entity_id: newUserId, user_id: newUserId, role }, { businessId });

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
  // business_id comes from the caller's session; any body-supplied value is ignored. Only a
  // super-admin, who has no business of their own, names the tenant (target_business_id).
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

      const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
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

      const businessId = await resolveCreationBusiness(pool, req, res);
      if (businessId == null) return;

      const input: CreateUserInput = { username, emailRaw, password, rawPassword, role, displayName, dni, businessId };

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

      const scope = userAdminScope(req, res);
      if (scope == null) return;

      // An admin deactivating themselves would lock the business out of its own admin surface.
      if (userId === sessionUser.id) {
        return sendError(res, 400, 'invalid_request', 'You cannot deactivate your own account', { detail: { key: 'cannotDeactivateSelf' } });
      }

      const deactivated = await deactivateUser(pool, {
        userId,
        scope,
        actorId: sessionUser.id,
      });

      if (!deactivated) {
        return sendError(res, 404, 'not_found', 'User not found', { detail: { key: 'userNotFound' } });
      }

      await deleteUserSessions(pool, userId);

      const { business_id: targetBusinessId, ...user } = deactivated;
      await audit(req, 'user_deactivated', 'success', { entity_type: 'auth.users', entity_id: userId, user_id: userId }, { businessId: numericBusiness(targetBusinessId) });

      return sendData(res, { user });
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

      if (isPasswordTooShort(typeof req.body.password === 'string' ? req.body.password : '')) {
        return sendError(res, 400, 'invalid_request', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
          detail: { key: PASSWORD_TOO_SHORT_KEY, params: { min: String(MIN_PASSWORD_LENGTH) } },
        });
      }

      if (!Number.isInteger(userId) || !password) {
        return sendError(res, 400, 'invalid_request', 'Valid user id and password are required', { detail: { key: 'userIdAndPasswordRequired' } });
      }

      const scope = userAdminScope(req, res);
      if (scope == null) return;

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
        scope,
        passwordHash,
        passwordSalt,
      });

      if (!reset) {
        return sendError(res, 404, 'not_found', 'User not found', { detail: { key: 'userNotFound' } });
      }

      await deleteUserSessions(pool, userId);

      const { business_id: targetBusinessId, ...user } = reset;
      await audit(req, 'password_reset', 'success', { entity_type: 'auth.users', entity_id: userId, user_id: userId }, { businessId: numericBusiness(targetBusinessId) });

      return sendData(res, { user });
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

      if (isPasswordTooShort(typeof req.body.password === 'string' ? req.body.password : '')) {
        return sendError(res, 400, 'invalid_request', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
          detail: { key: PASSWORD_TOO_SHORT_KEY, params: { min: String(MIN_PASSWORD_LENGTH) } },
        });
      }

      if (!Number.isInteger(userId) || !username || !password) {
        return sendError(res, 400, 'invalid_request', 'Valid user id, username and password are required', { detail: { key: 'userCredentialsRequired' } });
      }

      const scope = userAdminScope(req, res);
      if (scope == null) return;

      const target = await findContactOnlyClient(pool, { userId, scope });
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
          scope,
          username,
          email: emailRaw,
          passwordHash,
          passwordSalt,
        });

        if (!enabled) {
          return sendError(res, 404, 'not_found', 'Client not found', { detail: { key: 'clientNotFound' } });
        }

        await audit(req, 'login_enabled', 'success', { entity_type: 'auth.users', entity_id: userId, user_id: userId }, { businessId: numericBusiness(enabled.business_id) });

        return sendData(res, { id: enabled.id, username: enabled.username } satisfies EnabledLoginResult);
      } catch (error) {
        return sendUniqueConflict(res, error, 'Username already exists');
      }
    }),
  );
}
