import type { Express } from 'express';
import type { Queryable } from './db/core';
import { pingDatabase } from './db';
import { sendData, sendError } from './status_messages';

// GET /health runs a real DB query, not just process-up.
export function registerHealthRoute(app: Express, pool: Queryable) {
  app.get('/health', async (_req, res) => {
    try {
      await pingDatabase(pool);
      return sendData(res, { status: 'ok', database: 'up' });
    } catch {
      return sendError(res, 503, 'database_unavailable', 'Database health check failed');
    }
  });
}
