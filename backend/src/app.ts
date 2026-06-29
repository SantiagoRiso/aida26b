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

export type GenericRouteGuards = {
  read?: RequestHandler[];
  write?: RequestHandler[];
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

  app.get('/api/:tableName', ...read, (req, res) => getHandler(req, res, pool));
  app.post('/api/:tableName', ...write, (req, res) => postHandler(req, res, pool));
  app.put('/api/:tableName', ...write, (req, res) => putHandler(req, res, pool));
  app.delete('/api/:tableName', ...write, (req, res) => deleteHandler(req, res, pool));
}

// Call after body parsing and before static/catch-all so /health stays reachable.
export function mountObservability(app: express.Express, pool: Pool) {
  app.use(requestLogger());
  registerHealthRoute(app, pool);
}

// No-auth app used by DB/API tests. Runtime auth wiring lives in server.ts.
export function createApp(pool: Pool) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  mountObservability(app, pool);
  mountGenericRoutes(app, pool);

  app.use(express.static(path.join(__dirname, '../../frontend/dist')));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  });

  return app;
}

export const createAppGivenPool = createApp;
