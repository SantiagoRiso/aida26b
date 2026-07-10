import type express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from '../auth';
import { isRole } from '../../../shared/src/types/roles';
import { guardRoute } from '../helpers';
import { sendData, sendError } from '../status_messages';
import { readPassword, type AuditWriter } from '../session';
import { withTransaction } from '../db/core';
import { DbError } from '../db/errors';
import { insertUser, deactivateUser, resetUserPassword, deleteUserSessions } from '../db/users';

type AuthedRequest = Request & { user?: auth.AuthUser };

function isUniqueViolation(error: unknown): error is DbError {
  return error instanceof DbError && error.pgCode === '23505';
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
    '/api/admin/users',
    requireAuth,
    requirePasswordReady,
    guardRoute(async (req, res) => {
      const username =
        typeof req.body.username === 'string' ? req.body.username.trim() : '';

      // email is NOT NULL in the schema; fall back to a placeholder when no address is provided.
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

      const sessionUser = (req as AuthedRequest).user!;

      const mayCreate =
        sessionUser.role === 'Admin' ||
        ((sessionUser.role === 'Professional' || sessionUser.role === 'Receptionist') &&
          role === 'Client');

      if (!mayCreate) {
        await audit(req, 'permission_denied', 'denied', { path: req.path, method: req.method });
        return sendError(res, 403, 'forbidden', 'Forbidden');
      }

      if (!username || !password || !isRole(role)) {
        return sendError(res, 400, 'invalid_request', 'Valid username, password and role are required');
      }

      // A null business_id means "see/act across all businesses"; stamping it onto a new
      // user would mint a cross-tenant account. User creation requires a concrete business.
      if (sessionUser.business_id == null) {
        return sendError(res, 400, 'no_business', 'A business context is required to manage users');
      }
      const businessId = sessionUser.business_id;
      const email = emailRaw ?? `${username}@noemail.local`;
      const { passwordHash, passwordSalt } = await auth.hashPassword(password);

      try {
        // All person attributes (display_name, dni, phone, bio, notes) live on auth.users directly.
        const newUserId = await withTransaction(pool, async (tx) => {
          const inserted = await insertUser(tx, {
            username, email, displayName, dni,
            passwordHash, passwordSalt, role, businessId,
          });
          return Number(inserted!.id);
        });

        await audit(req, 'user_created', 'success', { user_id: newUserId, role });

        return sendData(res, { id: newUserId, username, role }, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          // dni is also unique per business; name the right conflict so the form can react.
          return sendError(
            res,
            409,
            'conflict',
            error.constraint === 'uq_users_business_dni' ? 'DNI already exists' : 'Username already exists',
          );
        }
        // guardRoute maps anything else (unexpected DbError → mapped code, else 500).
        throw error;
      }
    }),
  );

  // Role is immutable — change requires deactivate + recreate.
  app.post(
    '/api/admin/users/:id/deactivate',
    requireAuth,
    requirePasswordReady,
    requireAdmin,
    guardRoute(async (req, res) => {
      const userId = Number(req.params.id);
      const sessionUser = (req as AuthedRequest).user!;

      if (!Number.isInteger(userId)) {
        return sendError(res, 400, 'invalid_request', 'Valid user id is required');
      }

      if (sessionUser.business_id == null) {
        return sendError(res, 400, 'no_business', 'A business context is required to manage users');
      }

      // An admin deactivating themselves would lock the business out of its own admin surface.
      if (userId === sessionUser.id) {
        return sendError(res, 400, 'invalid_request', 'You cannot deactivate your own account');
      }

      const deactivated = await deactivateUser(pool, {
        userId,
        businessId: sessionUser.business_id,
        actorId: sessionUser.id,
      });

      if (!deactivated) {
        return sendError(res, 404, 'not_found', 'User not found');
      }

      await deleteUserSessions(pool, userId);

      await audit(req, 'user_deactivated', 'success', { user_id: userId });

      return sendData(res, { user: deactivated });
    }),
  );

  app.post(
    '/api/admin/users/:id/reset-password',
    requireAuth,
    requirePasswordReady,
    requireAdmin,
    guardRoute(async (req, res) => {
      const userId = Number(req.params.id);
      const password = readPassword(req.body.password);
      const sessionUser = (req as AuthedRequest).user!;

      if (!Number.isInteger(userId) || !password) {
        return sendError(res, 400, 'invalid_request', 'Valid user id and password are required');
      }

      if (sessionUser.business_id == null) {
        return sendError(res, 400, 'no_business', 'A business context is required to manage users');
      }

      // A self-reset forces must_change_password on the admin and kills their sessions,
      // locking them out; admins change their own password via /auth/change-password.
      if (userId === sessionUser.id) {
        return sendError(res, 400, 'invalid_request', 'You cannot reset your own password here; use change password instead');
      }

      const { passwordHash, passwordSalt } = await auth.hashPassword(password);

      // Scope by the admin's business so a tenant admin can only reset their own
      // users' passwords, never another business's accounts.
      const reset = await resetUserPassword(pool, {
        userId,
        businessId: sessionUser.business_id,
        passwordHash,
        passwordSalt,
      });

      if (!reset) {
        return sendError(res, 404, 'not_found', 'User not found');
      }

      await deleteUserSessions(pool, userId);

      await audit(req, 'password_reset', 'success', { user_id: userId });

      return sendData(res, { user: reset });
    }),
  );
}
