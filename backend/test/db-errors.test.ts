import { describe, test, expect } from 'vitest';
import { DbError, httpForDbError, PG_ERROR_MAP } from '../src/db/errors';
import {
  CONSTRAINT_DETAIL_KEYS,
  USER_IDENTITY_CONSTRAINT_DETAIL_KEYS,
} from '../../shared/src/ssot/domain/constraint-messages';

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

// A duplicate-key collapsed to the generic `conflict` code no matter which unique/check
// constraint fired, discarding the constraint name DbError.from already carries. These prove the
// constraint-name → detail.key lookup (shared/src/ssot/domain/constraint-messages.ts) actually
// wires through httpForDbError, and that the SQLSTATE→status/code mapping stays the fallback.
describe('httpForDbError — constraint name resolves a precise detail.key', () => {
  test.each(Object.entries(CONSTRAINT_DETAIL_KEYS))(
    '%s -> detail.key %s, status/code unchanged from the plain SQLSTATE mapping',
    (constraint, key) => {
      const bare = httpForDbError(new DbError('x', '23505'));
      const withConstraint = httpForDbError(new DbError('x', '23505', undefined, constraint));
      expect(withConstraint).toEqual({ ...bare, detail: { key } });
    },
  );

  test('a CHECK-violation constraint (23514) resolves through the same lookup', () => {
    const mapped = httpForDbError(
      new DbError('x', '23514', undefined, 'schedule_blocks_time_order'),
    );
    expect(mapped).toEqual({ status: 400, code: 'validation_error', message: expect.any(String), detail: { key: 'endAfterStart' } });
  });

  test('an unrecognized constraint name falls through to the generic SQLSTATE mapping, no detail', () => {
    const mapped = httpForDbError(new DbError('x', '23505', undefined, 'some_future_migration_constraint'));
    expect(mapped).toEqual({ status: 409, code: 'conflict', message: expect.any(String) });
    expect(mapped).not.toHaveProperty('detail');
  });

  test('no constraint at all still falls through to the generic SQLSTATE mapping, no detail', () => {
    const mapped = httpForDbError(new DbError('x', '23505'));
    expect(mapped).not.toHaveProperty('detail');
  });

  // The security-sensitive exclusion: auth.users' own unique constraints must NEVER be resolved
  // by the shared, route-agnostic httpForDbError. Only routes/users.ts's admin/staff-only surface
  // may name them (see constraint-messages.ts for the cross-tenant/self-service enumeration risk).
  test('auth.users identity constraints (username/email/DNI) are never mapped by the shared lookup', () => {
    for (const constraint of Object.keys(USER_IDENTITY_CONSTRAINT_DETAIL_KEYS)) {
      expect(CONSTRAINT_DETAIL_KEYS).not.toHaveProperty(constraint);
      const mapped = httpForDbError(new DbError('x', '23505', undefined, constraint));
      expect(mapped).not.toHaveProperty('detail');
    }
  });
});
