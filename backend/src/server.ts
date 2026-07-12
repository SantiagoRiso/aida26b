import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import { pool } from './db';
import { mountGenericRoutes, mountObservability } from './app';
import { createAuditWriter, createAuthGuards } from './session';
import { mountAuthRoutes } from './routes/auth';
import { mountUserAdminRoutes } from './routes/users';
import { mountGrantRoutes } from './routes/grants';
import { mountSchedulingRoutes } from './routes/scheduling';
import { mountAppointmentRoutes } from './routes/appointments';
import { mountLedgerRoutes } from './routes/ledger';
import { mountAuditRoutes } from './routes/audit';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// One known reverse-proxy hop (ingress) terminates TLS and sets X-Forwarded-For, so
// req.ip reflects the real client rather than the proxy. Audited IPs depend on this.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

// /health stays unauthenticated so container healthchecks can reach it.
mountObservability(app, pool);

const audit = createAuditWriter(pool);
const { requireAuth, requirePasswordReady, requireAdmin } = createAuthGuards(pool, audit);

mountAuthRoutes(app, pool, { audit, requireAuth });

mountUserAdminRoutes(app, pool, { audit, requireAuth, requirePasswordReady, requireAdmin });

// calendar_grants stays protected in SSOT (no generic CRUD), so grants need this explicit route.
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

// Schedule blocks + their services are edited through the generic CRUD engine (SSoT descriptors),
// scoped by ownership/calendar-grant; no bespoke set-schedule route.
mountAppointmentRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

// Immutable ARS ledger — append-only, never mutated.
mountLedgerRoutes(app, pool, {
  auth: requireAuth,
  passwordReady: requirePasswordReady,
  audit,
});

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
