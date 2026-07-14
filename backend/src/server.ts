import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import { pool } from './db';
import { createApp } from './app';
import { createAuthGuards } from './session';
import { createAuditWriter } from './audit';
import { mountAuthRoutes } from './routes/auth';
import { mountUserAdminRoutes } from './routes/users';
import { mountGrantRoutes } from './routes/grants';
import { mountBusinessClosureRoutes } from './routes/business-closures';
import { mountSchedulingRoutes } from './routes/scheduling';
import { mountAppointmentRoutes } from './routes/appointments';
import { mountLedgerRoutes } from './routes/ledger';
import { mountAuditRoutes } from './routes/audit';
import { mountBusinessSettingsRoutes } from './routes/business-settings';

dotenv.config();

const port = process.env.PORT || 3000;

const audit = createAuditWriter(pool);
const { requireAuth, requirePasswordReady, requireAdmin } = createAuthGuards(pool, audit);

let frontendDistPath = path.join(__dirname, '../../frontend/dist');

if (!fs.existsSync(path.join(frontendDistPath, 'index.html'))) {
  const fallbackPath = path.join(__dirname, '../../../../frontend/dist');

  if (fs.existsSync(path.join(fallbackPath, 'index.html'))) {
    frontendDistPath = fallbackPath;
  }
}

// One known reverse-proxy hop (ingress) terminates TLS and sets X-Forwarded-For, so
// req.ip reflects the real client rather than the proxy. Audited IPs depend on this.
const app = createApp(pool, {
  trustProxy: 1,
  distPath: frontendDistPath,
  // Role and business-scope decisions live inside handlers via the declarative gate.
  genericGuards: {
    read: [requireAuth, requirePasswordReady],
    write: [requireAuth, requirePasswordReady],
  },
  mountDomainRoutes: (app: express.Express) => {
    mountAuthRoutes(app, pool, { audit, requireAuth });

    mountUserAdminRoutes(app, pool, { audit, requireAuth, requirePasswordReady, requireAdmin });

    // calendar_grants stays protected in SSOT (no generic CRUD), so grants need this explicit route.
    mountGrantRoutes(app, pool, {
      auth: requireAuth,
      passwordReady: requirePasswordReady,
      audit,
    });

    // Business-wide closures are owner-less schedule_exceptions rows; the generic engine only writes
    // per-owner exceptions, so these Admin-scoped rows are created/read/deleted through this route.
    mountBusinessClosureRoutes(app, pool, {
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

    mountBusinessSettingsRoutes(app, pool, {
      auth: requireAuth,
      passwordReady: requirePasswordReady,
      audit,
    });
  },
});

export { app, pool };

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}
