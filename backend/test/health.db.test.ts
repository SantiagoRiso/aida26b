import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import { registerHealthRoute } from '../src/health';
import { resetTestDb, makeTestPool } from './helpers';

let pool: Pool;
let server: Server;
let base: string;

beforeAll(async () => {
  await resetTestDb();
  pool = makeTestPool();

  const app = express();
  registerHealthRoute(app, pool);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await pool.end();
  server.close();
});

describe('GET /health', () => {
  it('returns ok when the database answers SELECT 1', async () => {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { status: 'ok', database: 'up' } });
  });

  it('returns a 503 error envelope when the DB probe fails', async () => {
    const failing = express();
    registerHealthRoute(failing, {
      query: async () => {
        throw new Error('SELECT 1 unreachable');
      },
    });
    const s = failing.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => s.once('listening', () => resolve()));
    const failingBase = `http://127.0.0.1:${(s.address() as { port: number }).port}`;

    try {
      const res = await fetch(`${failingBase}/health`);
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('database_unavailable');
    } finally {
      s.close();
    }
  });
});
