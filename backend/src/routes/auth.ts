import type express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from '../auth';
import { sendData, sendError } from '../status_messages';
import { readPassword } from '../auth';
import type { AuditWriter } from '../audit';
import { authenticatedUser, getSessionToken, loadSession, setAuthenticatedUser } from '../session';
import { guardRoute } from '../helpers';
import {
  findUserForLogin,
  createSession,
  deleteSessionByToken,
  getPasswordCreds,
  updateUserPassword,
  deleteOtherSessions,
} from '../db/auth';
import { getSelfProfile, updateSelfProfile } from '../db/users';
import { AUTH_PATTERNS } from '../../../shared/src/ssot/api-paths';
import { EMAIL_PATTERN } from '../../../shared/src/ssot/domain/people';

const EMAIL_RE = new RegExp(EMAIL_PATTERN);

// Fixed dummy salt/hash for the login path: verifying against these when the username
// is unknown keeps scrypt cost identical to the real-account path (anti-enumeration).
// 128 hex chars = 64 bytes, matching scrypt's output length so the comparison runs.
const DUMMY_PASSWORD_SALT = '0'.repeat(32);
const DUMMY_PASSWORD_HASH = '0'.repeat(128);

export function mountAuthRoutes(
  app: express.Application,
  pool: Pool,
  deps: { audit: AuditWriter; requireAuth: RequestHandler },
) {
  const { audit, requireAuth } = deps;

  app.post(AUTH_PATTERNS.login, guardRoute(async (req, res) => {
    const username =
      typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password =
      typeof req.body.password === 'string' ? req.body.password : '';

    const row = await findUserForLogin(pool, username);

    // Always run scrypt — even for an unknown username — against a fixed dummy hash so
    // login response time can't be used to enumerate which usernames exist.
    const salt = row?.password_salt ?? DUMMY_PASSWORD_SALT;
    const hash = row?.password_hash ?? DUMMY_PASSWORD_HASH;
    const passwordOk = await auth.verifyPassword(password, salt, hash);

    const ok = !!row && row.is_active === true && passwordOk;

    if (!ok) {
      // Record failed attempts against a real account (resolved from the row); attempts on an
      // unknown username have no business to attribute and are not audited.
      await audit(req, 'login_failed', 'failure', { username }, {
        actorId: row ? Number(row.id) : null,
        businessId: row?.business_id != null ? Number(row.business_id) : null,
      });
      return sendError(res, 401, 'invalid_credentials', 'Invalid credentials', { detail: { key: 'invalidCredentials' } });
    }

    const user = auth.publicUser(row);
    const token = auth.newSessionToken();

    await createSession(pool, user.id, auth.hashToken(token));

    setAuthenticatedUser(req, user);

    await audit(req, 'login_success', 'success');

    res.setHeader('Set-Cookie', auth.sessionCookie(token, process.env.NODE_ENV === 'production'));

    return sendData(res, { user });
  }));

  app.post(AUTH_PATTERNS.logout, guardRoute(async (req, res) => {
    const token = getSessionToken(req);

    if (token) {
      const user = await loadSession(pool, req);
      if (user) {
        setAuthenticatedUser(req, user);
      }
      await deleteSessionByToken(pool, auth.hashToken(token));
      await audit(req, 'logout', 'success');
    }

    res.setHeader('Set-Cookie', auth.clearSessionCookie(process.env.NODE_ENV === 'production'));
    return res.status(204).send();
  }));

  app.get(AUTH_PATTERNS.me, requireAuth, (req, res) => {
    return sendData(res, { user: authenticatedUser(req) });
  });

  app.post(AUTH_PATTERNS.changePassword, requireAuth, guardRoute(async (req, res) => {
    const currentPassword =
      typeof req.body.current_password === 'string' ? req.body.current_password : '';
    const newPassword = readPassword(req.body.new_password);
    const user = authenticatedUser(req);

    if (!currentPassword || !newPassword) {
      return sendError(res, 400, 'invalid_request', 'Current password and a valid new password are required', { detail: { key: 'currentAndNewPasswordRequired' } });
    }

    const current = await getPasswordCreds(pool, user.id);

    const ok =
      current !== null && (await auth.verifyPassword(currentPassword, current.password_salt, current.password_hash));

    if (!ok) {
      await audit(req, 'password_change_failed', 'failure');
      return sendError(res, 401, 'invalid_current_password', 'Invalid current password', { detail: { key: 'invalidCurrentPassword' } });
    }

    // Reusing the current password defeats a forced reset, so reject it.
    const sameAsCurrent = await auth.verifyPassword(newPassword, current.password_salt, current.password_hash);
    if (sameAsCurrent) {
      return sendError(res, 400, 'password_reuse', 'New password must be different from the current password', { detail: { key: 'passwordReuse' } });
    }

    const { passwordHash, passwordSalt } = await auth.hashPassword(newPassword);

    const updatedRow = await updateUserPassword(pool, user.id, passwordHash, passwordSalt);
    if (!updatedRow) return sendError(res, 404, 'not_found', 'User not found', { detail: { key: 'userNotFound' } });

    // Invalidate the user's other sessions so a changed password locks out anyone
    // holding an older token; the current session stays valid.
    const currentToken = getSessionToken(req);
    if (currentToken) {
      await deleteOtherSessions(pool, user.id, auth.hashToken(currentToken));
    }

    setAuthenticatedUser(req, auth.publicUser(updatedRow));

    await audit(req, 'password_changed', 'success');

    return sendData(res, { user: authenticatedUser(req) });
  }));

  app.get(AUTH_PATTERNS.meProfile, requireAuth, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const profile = await getSelfProfile(pool, user.id);
    if (!profile) return sendError(res, 404, 'not_found', 'Profile not found', { detail: { key: 'profileNotFound' } });
    return sendData(res, { profile });
  }));

  app.patch(AUTH_PATTERNS.meProfile, requireAuth, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const displayName = typeof req.body.display_name === 'string' ? req.body.display_name.trim() : '';
    const email = typeof req.body.email === 'string' && req.body.email.trim() !== '' ? req.body.email.trim() : null;
    const bio = typeof req.body.bio === 'string' && req.body.bio.trim() !== '' ? req.body.bio : null;
    const phone = typeof req.body.phone === 'string' && req.body.phone.trim() !== '' ? req.body.phone.trim() : null;

    if (!displayName) return sendError(res, 400, 'invalid_request', 'Display name is required', { detail: { key: 'displayNameRequired' } });

    if (email !== null && !EMAIL_RE.test(email)) {
      return sendError(res, 400, 'invalid_request', 'A valid email is required', { detail: { key: 'emailFormat' } });
    }

    const current = await getSelfProfile(pool, user.id);
    if (!current) return sendError(res, 404, 'not_found', 'Profile not found', { detail: { key: 'profileNotFound' } });

    // Reaching this route means holding a session, which means holding a username, and a row with a
    // username always carries an email. Nobody may drop the one they have: it is how they are reached.
    if (email === null) {
      return sendError(res, 400, 'invalid_request', 'A valid email is required', { detail: { key: 'emailFormat' } });
    }

    // Duplicate email -> DbError(23505) -> guardRoute maps to 409.
    const updated = await updateSelfProfile(pool, { userId: user.id, displayName, bio, email, phone });
    if (!updated) return sendError(res, 404, 'not_found', 'Profile not found', { detail: { key: 'profileNotFound' } });

    // email is part of the session identity; refresh it so the header/store stay in sync.
    setAuthenticatedUser(req, { ...user, email: updated.email });
    await audit(req, 'profile_updated', 'success');
    return sendData(res, { profile: updated, user: authenticatedUser(req) });
  }));
}
