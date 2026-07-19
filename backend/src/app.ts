import { Pool } from 'pg';
import cors from 'cors';
import path from 'path';
import express from 'express';
import type { RequestHandler } from 'express';
import { getHandler } from './routes/get';
import { putHandler } from './routes/put';
import { postHandler } from './routes/post';
import { deleteHandler } from './routes/delete';
import { requestLogger } from './logger';
import { registerHealthRoute } from './health';
import { guardRoute } from './helpers';
import type { AuthUser } from './auth';
import { optionalAuthenticatedUser, setAuthenticatedUser } from './session';
import { CRUD_PATTERNS } from '../../shared/src/ssot/api-paths';

export type GenericRouteGuards = {
  read?: RequestHandler[];
  write?: RequestHandler[];
};

export type CreateAppOptions = {
  // When set, every request that has no `req.user` attached by auth middleware
  // will receive this user instead of the hardcoded Admin-null fallback in each
  // handler. Useful in DB tests that need a real business_id without wiring sessions.
  defaultUser?: AuthUser;
  // Express `trust proxy` value; the runtime server sets 1 (one known ingress hop)
  // so req.ip — and the audited IPs derived from it — reflect the real client.
  trustProxy?: number | boolean;
  // Frontend bundle directory for static assets and the SPA fallback.
  distPath?: string;
  // Auth middleware layered onto the generic CRUD routes (runtime only; tests run open).
  genericGuards?: GenericRouteGuards;
  // Mounted between observability and the generic CRUD routes — bespoke routes must win
  // over /api/:tableName, and the generic stack must precede the static/SPA fallback.
  mountDomainRoutes?: (app: express.Express) => void;
};

// Shared generic CRUD route stack so the test app and the runtime server never drift.
export function mountGenericRoutes(
  app: express.Express,
  pool: Pool,
  guards: GenericRouteGuards = {}
) {
  const read = guards.read ?? [];
  const write = guards.write ?? [];

  app.get(CRUD_PATTERNS.collection, ...read, guardRoute((req, res) => getHandler(req, res, pool)));
  app.post(CRUD_PATTERNS.collection, ...write, guardRoute((req, res) => postHandler(req, res, pool)));
  // Frontend calls PUT/DELETE with the row id as a path segment (crud.ts updateRow/deleteRow).
  app.put(CRUD_PATTERNS.item, ...write, guardRoute((req, res) => putHandler(req, res, pool)));
  app.delete(CRUD_PATTERNS.item, ...write, guardRoute((req, res) => deleteHandler(req, res, pool)));
}

// /health stays unauthenticated so container healthchecks can reach it.
export function mountObservability(app: express.Express, pool: Pool) {
  app.use(requestLogger());
  registerHealthRoute(app, pool);
}

// The single app assembly: the runtime server passes its auth wiring and env-derived paths;
// tests call it bare (no auth, default dist) so both stacks share one middleware order.
export function createApp(pool: Pool, options: CreateAppOptions = {}) {
  const app = express();

  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  }

  app.use(cors());
  app.use(express.json());

  // Inject a default user on every request so handlers that read req.user get a
  // real business context without requiring a session cookie. Only applies when no
  // upstream middleware has already set req.user (so the runtime server is unaffected).
  if (options.defaultUser) {
    const defaultUser = options.defaultUser;
    app.use((req, _res, next) => {
      if (!optionalAuthenticatedUser(req)) setAuthenticatedUser(req, defaultUser);
      next();
    });
  }

  mountObservability(app, pool);
  options.mountDomainRoutes?.(app);
  mountGenericRoutes(app, pool, options.genericGuards);

  const distPath = options.distPath ?? path.join(__dirname, '../../frontend/dist');
  app.use(express.static(distPath));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  return app;
}
