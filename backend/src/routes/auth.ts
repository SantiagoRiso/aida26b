import type express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import * as auth from '../auth';
import { getSessionToken, loadSession, readPassword, type AuditWriter } from '../session';

type AuthedRequest = Request & { user?: auth.AuthUser };

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

  app.post('/api/auth/login', async (req, res) => {
    try {
      const username =
        typeof req.body.username === 'string' ? req.body.username.trim() : '';
      const password =
        typeof req.body.password === 'string' ? req.body.password : '';

      const result = await pool.query(
        `SELECT
           id, username, email, password_hash, password_salt,
           role, business_id, is_active, must_change_password
         FROM auth.users
         WHERE username = $1`,
        [username],
      );

      const row = result.rows[0];

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
          actorId: row?.id ?? null,
          businessId: row?.business_id ?? null,
        });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = auth.publicUser(row);
      const token = auth.newSessionToken();

      await pool.query(
        `INSERT INTO auth.sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '7 days')`,
        [user.id, auth.hashToken(token)],
      );

      (req as AuthedRequest).user = user;

      await audit(req, 'login_success', 'success');

      res.setHeader('Set-Cookie', auth.sessionCookie(token, process.env.NODE_ENV === 'production'));

      return res.json({ user });
    } catch (error) {
      console.error('Error logging in:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    try {
      const token = getSessionToken(req);

      if (token) {
        const user = await loadSession(pool, req);
        if (user) {
          (req as AuthedRequest).user = user;
        }
        await pool.query('DELETE FROM auth.sessions WHERE token_hash = $1', [auth.hashToken(token)]);
        await audit(req, 'logout', 'success');
      }

      res.setHeader('Set-Cookie', auth.clearSessionCookie(process.env.NODE_ENV === 'production'));
      return res.status(204).send();
    } catch (error) {
      console.error('Error logging out:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    return res.json({ user: (req as AuthedRequest).user });
  });

  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
      const currentPassword =
        typeof req.body.current_password === 'string' ? req.body.current_password : '';
      const newPassword = readPassword(req.body.new_password);
      const user = (req as AuthedRequest).user!;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          error: 'Current password and a valid new password are required',
        });
      }

      const current = await pool.query(
        'SELECT password_hash, password_salt FROM auth.users WHERE id = $1',
        [user.id],
      );
      const row = current.rows[0];

      const ok =
        row && (await auth.verifyPassword(currentPassword, row.password_salt, row.password_hash));

      if (!ok) {
        await audit(req, 'password_change_failed', 'failure');
        return res.status(401).json({ error: 'Invalid current password' });
      }

      // Reusing the current password defeats a forced reset, so reject it.
      const sameAsCurrent = await auth.verifyPassword(newPassword, row.password_salt, row.password_hash);
      if (sameAsCurrent) {
        return res.status(400).json({
          error: 'New password must be different from the current password',
        });
      }

      const { passwordHash, passwordSalt } = await auth.hashPassword(newPassword);

      const result = await pool.query(
        `UPDATE auth.users
         SET password_hash = $1, password_salt = $2, must_change_password = false, updated_at = now()
         WHERE id = $3
         RETURNING id, username, email, role, business_id, is_active, must_change_password`,
        [passwordHash, passwordSalt, user.id],
      );

      // Invalidate the user's other sessions so a changed password locks out anyone
      // holding an older token; the current session stays valid.
      const currentToken = getSessionToken(req);
      if (currentToken) {
        await pool.query(
          'DELETE FROM auth.sessions WHERE user_id = $1 AND token_hash <> $2',
          [user.id, auth.hashToken(currentToken)],
        );
      }

      (req as AuthedRequest).user = auth.publicUser(result.rows[0]);

      await audit(req, 'password_changed', 'success');

      return res.json({ user: (req as AuthedRequest).user });
    } catch (error) {
      console.error('Error changing password:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
