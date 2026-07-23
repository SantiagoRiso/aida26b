import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db';

// A17: the pool used to set only host/port/db/user/password, leaving `max` at pg's implicit
// default and no connectionTimeoutMillis — once all clients were checked out, a further request
// queued forever instead of failing fast. Asserts the constructor options actually took (Pool
// exposes what it was constructed with via `.options`), not just that db.ts contains the right text.
describe('pool configuration', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('caps concurrent clients explicitly rather than relying on the implicit default', () => {
    expect(pool.options.max).toBe(10);
  });

  it('fails fast instead of queuing forever once the pool is exhausted', () => {
    expect(pool.options.connectionTimeoutMillis).toBe(5000);
    expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0);
  });
});
