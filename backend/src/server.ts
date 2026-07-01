import express from 'express';
import type { Request, RequestHandler } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import * as auth from './auth';

import { mountGenericRoutes, mountObservability } from './app';
import { mountGrantRoutes } from './routes/grants';
import { mountSchedulingRoutes } from './routes/scheduling';
import { mountSetScheduleRoutes } from './routes/set-schedule';
import { mountAppointmentRoutes } from './routes/appointments';
import { mountLedgerRoutes } from './routes/ledger';
import { mountAuditRoutes } from './routes/audit';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Fixed dummy salt/hash for the login path: verifying against these when the username
// is unknown keeps scrypt cost identical to the real-account path (anti-enumeration).
// 128 hex chars = 64 bytes, matching scrypt's output length so the comparison runs.
const DUMMY_PASSWORD_SALT = '0'.repeat(32);
const DUMMY_PASSWORD_HASH = '0'.repeat(128);

// One known reverse-proxy hop (ingress) terminates TLS and sets X-Forwarded-For, so
// req.ip reflects the real client rather than the proxy. Audited IPs depend on this.
app.set('trust proxy', 1);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

app.use(cors());
app.use(express.json());

// /health stays unauthenticated so container healthchecks can reach it.
mountObservability(app, pool);

type AuthedRequest = Request & { user?: auth.AuthUser };

function getSessionToken(req: Request) {
  return auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
}

function readPassword(value: unknown) {
  return typeof value === 'string' && value.length >= 8 ? value : null;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

// audit_events.business_id is NOT NULL. By default the business is derived from the actor's
// session; callers may pass an explicit actor/business to record events with no session
// (e.g. a failed login, resolved from the attempted account). The write is skipped only when
// no business resolves. Best-effort: a failure never breaks the request.
async function audit(
  req: Request,
  eventType: string,
  outcome: string,
  details: Record<string, unknown> = {},
  override: { actorId?: number | null; businessId?: number | null } = {}
) {
  try {
    const actorId =
      override.actorId !== undefined
        ? override.actorId
        : (req as AuthedRequest).user?.id ?? null;

    let businessId: number | null;
    if (override.businessId !== undefined) {
      businessId = override.businessId;
    } else {
      if (actorId === null) {
        return;
      }
      const business = await pool.query<{ business_id: number | null }>(
        'SELECT business_id FROM auth.users WHERE id = $1',
        [actorId]
      );
      businessId = business.rows[0]?.business_id ?? null;
    }

    if (businessId === null) {
      return;
    }

    await pool.query(
      `INSERT INTO audit_events
       (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, ip, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        businessId,
        actorId,
        eventType,
        (details.entity_type as string) ?? null,
        (details.entity_id as number) ?? null,
        outcome,
        req.ip,
        JSON.stringify(details),
      ]
    );
  } catch (error) {
    console.error('Error writing audit event:', error);
  }
}

async function loadSession(req: Request) {
  const token = getSessionToken(req);

  if (!token) {
    return null;
  }

  const result = await pool.query(
    `SELECT
       s.id AS session_id,
       u.id,
       u.username,
       u.email,
       u.role,
       u.business_id,
       u.is_active,
       u.must_change_password
     FROM auth.sessions s
     JOIN auth.users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND u.is_active = true`,
    [auth.hashToken(token)]
  );

  return result.rows[0] ? auth.publicUser(result.rows[0]) : null;
}

const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const user = await loadSession(req);

    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    (req as AuthedRequest).user = user;
    next();
  } catch (error) {
    next(error);
  }
};

const requirePasswordReady: RequestHandler = (req, res, next) => {
  if ((req as AuthedRequest).user?.must_change_password) {
    return res.status(403).json({ error: 'Password change required' });
  }

  next();
};

const requireAdmin: RequestHandler = async (req, res, next) => {
  if ((req as AuthedRequest).user?.role === 'Admin') {
    return next();
  }

  await audit(req, 'permission_denied', 'denied', {
    path: req.path,
    method: req.method,
  });

  return res.status(403).json({ error: 'Forbidden' });
};

app.post('/api/auth/login', async (req, res) => {
  try {
    const username =
      typeof req.body.username === 'string' ? req.body.username.trim() : '';

    const password =
      typeof req.body.password === 'string' ? req.body.password : '';

    const result = await pool.query(
      `SELECT
         id,
         username,
         email,
         password_hash,
         password_salt,
         role,
         business_id,
         is_active,
         must_change_password
       FROM auth.users
       WHERE username = $1`,
      [username]
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
      [user.id, auth.hashToken(token)]
    );

    (req as AuthedRequest).user = user;

    await audit(req, 'login_success', 'success');

    res.setHeader(
      'Set-Cookie',
      auth.sessionCookie(token, process.env.NODE_ENV === 'production')
    );

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
      const user = await loadSession(req);

      if (user) {
        (req as AuthedRequest).user = user;
      }

      await pool.query('DELETE FROM auth.sessions WHERE token_hash = $1', [
        auth.hashToken(token),
      ]);

      await audit(req, 'logout', 'success');
    }

    res.setHeader(
      'Set-Cookie',
      auth.clearSessionCookie(process.env.NODE_ENV === 'production')
    );

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
      typeof req.body.current_password === 'string'
        ? req.body.current_password
        : '';

    const newPassword = readPassword(req.body.new_password);
    const user = (req as AuthedRequest).user!;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Current password and a valid new password are required',
      });
    }

    const current = await pool.query(
      'SELECT password_hash, password_salt FROM auth.users WHERE id = $1',
      [user.id]
    );

    const row = current.rows[0];

    const ok =
      row &&
      (await auth.verifyPassword(
        currentPassword,
        row.password_salt,
        row.password_hash
      ));

    if (!ok) {
      await audit(req, 'password_change_failed', 'failure');
      return res.status(401).json({ error: 'Invalid current password' });
    }

    const { passwordHash, passwordSalt } = await auth.hashPassword(newPassword);

    const result = await pool.query(
      `UPDATE auth.users
       SET
         password_hash = $1,
         password_salt = $2,
         must_change_password = false,
         updated_at = now()
       WHERE id = $3
       RETURNING id, username, email, role, business_id, is_active, must_change_password`,
      [passwordHash, passwordSalt, user.id]
    );

    // Invalidate the user's other sessions so a changed password locks out anyone
    // holding an older token; the current session stays valid.
    const currentToken = getSessionToken(req);
    if (currentToken) {
      await pool.query(
        'DELETE FROM auth.sessions WHERE user_id = $1 AND token_hash <> $2',
        [user.id, auth.hashToken(currentToken)]
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

// Role is immutable after creation — change requires deactivate + recreate.
// business_id comes from the admin session; any body-supplied value is ignored.
app.post(
  '/api/admin/users',
  requireAuth,
  requirePasswordReady,
  requireAdmin,
  async (req, res) => {
    const username =
      typeof req.body.username === 'string' ? req.body.username.trim() : '';

    // email is NOT NULL in the schema; fall back to a placeholder when no address is provided.
    const emailRaw =
      typeof req.body.email === 'string' && req.body.email.trim()
        ? req.body.email.trim()
        : null;

    const password = readPassword(req.body.password);
    const role = req.body.role;
    const displayName =
      typeof req.body.display_name === 'string' && req.body.display_name.trim()
        ? req.body.display_name.trim()
        : username;

    if (!username || !password || !auth.isRole(role)) {
      return res.status(400).json({
        error: 'Valid username, password and role are required',
      });
    }

    const sessionUser = (req as AuthedRequest).user!;

    // A null business_id means "see/act across all businesses"; stamping it onto a new
    // user would mint a cross-tenant account. Admin user-management requires a concrete business.
    if (sessionUser.business_id == null) {
      return res.status(400).json({
        error: 'A business context is required to manage users',
      });
    }
    const email = emailRaw ?? `${username}@noemail.local`;
    const { passwordHash, passwordSalt } = await auth.hashPassword(password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // All person attributes (display_name, phone, bio, notes) live on auth.users directly.
      const userResult = await client.query(
        `INSERT INTO auth.users
           (username, email, display_name, password_hash, password_salt, role, business_id, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         RETURNING id`,
        [username, email, displayName, passwordHash, passwordSalt, role, sessionUser.business_id]
      );
      const newUserId: number = userResult.rows[0].id;

      await client.query('COMMIT');

      await audit(req, 'user_created', 'success', { user_id: newUserId, role });

      return res.status(201).json({ id: newUserId, username, role });
    } catch (error) {
      await client.query('ROLLBACK');

      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      console.error('Error creating user:', error);
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  }
);

// Soft-deactivates a user; deletes their sessions. Role is immutable — change requires deactivate + recreate.
app.post(
  '/api/admin/users/:id/deactivate',
  requireAuth,
  requirePasswordReady,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const sessionUser = (req as AuthedRequest).user!;

      if (!Number.isInteger(userId)) {
        return res.status(400).json({ error: 'Valid user id is required' });
      }

      if (sessionUser.business_id == null) {
        return res.status(400).json({
          error: 'A business context is required to manage users',
        });
      }

      const result = await pool.query(
        `UPDATE auth.users
         SET is_active = false, deleted_at = now(), deleted_by_user_id = $1, updated_at = now()
         WHERE id = $2 AND business_id = $3 AND is_active = true
         RETURNING id, username, role`,
        [sessionUser.id, userId, sessionUser.business_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      await pool.query('DELETE FROM auth.sessions WHERE user_id = $1', [userId]);

      await audit(req, 'user_deactivated', 'success', { user_id: userId });

      return res.json({ user: result.rows[0] });
    } catch (error) {
      console.error('Error deactivating user:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

app.post(
  '/api/admin/users/:id/reset-password',
  requireAuth,
  requirePasswordReady,
  requireAdmin,
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const password = readPassword(req.body.password);
      const sessionUser = (req as AuthedRequest).user!;

      if (!Number.isInteger(userId) || !password) {
        return res.status(400).json({
          error: 'Valid user id and password are required',
        });
      }

      if (sessionUser.business_id == null) {
        return res.status(400).json({
          error: 'A business context is required to manage users',
        });
      }

      const { passwordHash, passwordSalt } = await auth.hashPassword(password);

      // Scope by the admin's business so a tenant admin can only reset their own
      // users' passwords, never another business's accounts.
      const result = await pool.query(
        `UPDATE auth.users
         SET
           password_hash = $1,
           password_salt = $2,
           must_change_password = true,
           updated_at = now()
         WHERE id = $3 AND business_id = $4 AND is_active = true
         RETURNING id, username, email, role, is_active, must_change_password`,
        [passwordHash, passwordSalt, userId, sessionUser.business_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      await pool.query('DELETE FROM auth.sessions WHERE user_id = $1', [userId]);

      await audit(req, 'password_reset', 'success', { user_id: userId });

      return res.json({ user: result.rows[0] });
    } catch (error) {
      console.error('Error resetting password:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Explicit grant-management surface; calendar_grants stays protected in SSOT (no generic CRUD).
mountGrantRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Advisory conflict-check + availability reads; report-only, no appointment writes.
mountSchedulingRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Set-weekly-schedule: per-block-granularity validation + one-owner rule + own-schedule authz.
mountSetScheduleRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Full appointment lifecycle: request/schedule/approve/reschedule/transition/PATCH + reads.
mountAppointmentRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Immutable ARS ledger: entry create + balance + paginated history.
mountLedgerRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Admin audit view (filtered, paginated) + admin business settings endpoint.
mountAuditRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Same route stack as the test app factory, with the runtime auth guards layered on.
// Role and business-scope decisions live inside handlers via the declarative gate.
mountGenericRoutes(app, pool, {
  read: [requireAuth, requirePasswordReady],
  write: [requireAuth, requirePasswordReady],
});

let frontendDistPath = path.join(__dirname, '../../frontend/dist');

if (!fs.existsSync(path.join(frontendDistPath, 'index.html'))) {
  const fallbackPath = path.join(__dirname, '../../../../frontend/dist');

  if (fs.existsSync(path.join(fallbackPath, 'index.html'))) {
    frontendDistPath = fallbackPath;
  }
}

app.use(express.static(frontendDistPath));

app.get('*', (_req, res) => {
  return res.sendFile(path.join(frontendDistPath, 'index.html'));
});

export { app, pool };

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}
