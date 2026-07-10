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

export type GenericRouteGuards = {
  read?: RequestHandler[];
  write?: RequestHandler[];
};

export type CreateAppOptions = {
  // When set, every request that has no `req.user` attached by auth middleware
  // will receive this user instead of the hardcoded Admin-null fallback in each
  // handler. Useful in DB tests that need a real business_id without wiring sessions.
  defaultUser?: AuthUser;
};

// Shared generic CRUD route stack so the test app and the runtime server never drift.
// Callers supply the auth/authorization guards.
export function mountGenericRoutes(
  app: express.Express,
  pool: Pool,
  guards: GenericRouteGuards = {}
) {
  const read = guards.read ?? [];
  const write = guards.write ?? [];

  app.get('/api/:tableName', ...read, guardRoute((req, res) => getHandler(req, res, pool)));
  app.post('/api/:tableName', ...write, guardRoute((req, res) => postHandler(req, res, pool)));
  // Frontend calls PUT/DELETE with the row id as a path segment (crud.ts updateRow/deleteRow).
  app.put('/api/:tableName/:id', ...write, guardRoute((req, res) => putHandler(req, res, pool)));
  app.delete('/api/:tableName/:id', ...write, guardRoute((req, res) => deleteHandler(req, res, pool)));
}

export function mountObservability(app: express.Express, pool: Pool) {
  app.use(requestLogger());
  registerHealthRoute(app, pool);
}

// No-auth app used by DB/API tests. Runtime auth wiring lives in server.ts.
export function createApp(pool: Pool, options: CreateAppOptions = {}) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Inject a default user on every request so handlers that read req.user get a
  // real business context without requiring a session cookie. Only applies when no
  // upstream middleware has already set req.user (so runtime server.ts is unaffected).
  if (options.defaultUser) {
    const defaultUser = options.defaultUser;
    app.use((req, _res, next) => {
      const r = req as express.Request & { user?: AuthUser };
      if (!r.user) r.user = defaultUser;
      next();
    });
  }

  mountObservability(app, pool);
  mountGenericRoutes(app, pool);

  app.use(express.static(path.join(__dirname, '../../frontend/dist')));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  });

  return app;
}

export const createAppGivenPool = createApp;
