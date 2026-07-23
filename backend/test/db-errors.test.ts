import { describe, test, expect } from 'vitest';
import { DbError, httpForDbError, PG_ERROR_MAP } from '../src/db/errors';

describe('DbError.from', () => {
  test('wraps a raw pg-shaped error, carrying code and constraint', () => {
    const raw = { message: 'duplicate key value violates unique constraint "clients_email_key"', code: '23505', constraint: 'clients_email_key' };
    const err = DbError.from(raw);
    expect(err).toBeInstanceOf(DbError);
    expect(err.pgCode).toBe('23505');
    expect(err.constraint).toBe('clients_email_key');
  });

  test('passes an existing DbError through unchanged', () => {
    const original = new DbError('boom', '23505');
    expect(DbError.from(original)).toBe(original);
  });

  test('falls back to a generic message when the thrown value carries none', () => {
    expect(DbError.from(null).message).toBe('Database error');
  });
});

describe('httpForDbError — previously-mapped codes still hold', () => {
  test('23505 (unique_violation) -> 409 conflict', () => {
    expect(httpForDbError(new DbError('x', '23505'))).toEqual({ status: 409, code: 'conflict', message: expect.any(String) });
  });

  test('23503 (foreign_key_violation) -> 400 invalid_request', () => {
    expect(httpForDbError(new DbError('x', '23503'))).toEqual({ status: 400, code: 'invalid_request', message: expect.any(String) });
  });

  test('an unmapped code still returns null (falls through to 500 in guardRoute)', () => {
    expect(httpForDbError(new DbError('deadlock detected', '40P01'))).toBeNull();
  });

  test('a non-DbError with no .code returns null', () => {
    expect(httpForDbError(new Error('plain failure'))).toBeNull();
  });
});

// A5: previously-uncovered SQLSTATEs that reach the API from an authenticated client — DB-only
// rules (CHECK/NOT NULL/type coercion) and statement/lock-timeout cancellations — must not fall
// through to a bare 500.
describe('httpForDbError — newly mapped SQLSTATEs', () => {
  const cases: Array<[string, number, string]> = [
    ['23514', 400, 'validation_error'], // check_violation — e.g. schedule_blocks_time_order
    ['23502', 400, 'validation_error'], // not_null_violation
    ['22001', 400, 'validation_error'], // string_data_right_truncation
    ['22003', 400, 'validation_error'], // numeric_value_out_of_range
    ['22007', 400, 'validation_error'], // invalid_datetime_format
    ['P0001', 400, 'validation_error'], // generic RAISE EXCEPTION fallback
    ['57014', 503, 'database_unavailable'], // query_canceled (statement_timeout)
    ['55P03', 503, 'database_unavailable'], // lock_not_available (lock_timeout)
  ];

  test.each(cases)('%s maps to %d / %s', (pgCode, status, code) => {
    const mapped = httpForDbError(new DbError('raw postgres text nobody should see', pgCode));
    expect(mapped).toEqual({ status, code, message: expect.any(String) });
  });

  test('every mapped code reuses an already-translated apiError.code (no bare SQLSTATE text, no raw pg message, leaks to the client code)', () => {
    for (const [pgCode, entry] of Object.entries(PG_ERROR_MAP)) {
      expect(entry.code).not.toMatch(/^[0-9A-Z]{5}$/); // not a raw SQLSTATE standing in for a code
      expect(entry.message.toLowerCase()).not.toContain('postgres');
      expect(pgCode).toMatch(/^[0-9A-Z]{5}$/); // sanity: keys are SQLSTATEs
    }
  });
});
