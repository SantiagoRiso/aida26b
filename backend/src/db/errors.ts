import { CONSTRAINT_DETAIL_KEYS } from '../../../shared/src/ssot/domain/constraint-messages';

export class DbError extends Error {
  constructor(
    message: string,
    public readonly pgCode?: string,
    // eslint-disable-next-line no-restricted-syntax -- carries whatever the pg driver/caller threw; shape is unverified until narrowed at the throw site
    public readonly cause?: unknown,
    // pg constraint name — lets callers distinguish which unique/FK constraint fired.
    public readonly constraint?: string,
  ) {
    super(message);
    this.name = 'DbError';
  }

  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: the pg driver throws an unverified error shape
  static from(e: unknown): DbError {
    if (e instanceof DbError) return e;
    const err = e as { message?: string; code?: string; constraint?: string } | null;
    const code = typeof err?.code === 'string' ? err.code : undefined;
    const constraint = typeof err?.constraint === 'string' ? err.constraint : undefined;
    return new DbError(err?.message ?? 'Database error', code, e, constraint);
  }
}

// SQLSTATE → HTTP. Withheld codes fall through to a generic 500.
// Every code below reuses an existing translated apiError.code (see frontend/src/i18n/es.ts) —
// no new code needed a translation. `message` is English prose for logs only; the client resolves
// wording from `code` (or `detail`, which none of these set).
export const PG_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'conflict', message: 'Resource already exists' },
  '23503': { status: 400, code: 'invalid_request', message: 'Referenced resource does not exist' },
  // Data-shape violations caught by the database rather than the app-level validator (a CHECK
  // constraint, a NOT NULL column, a value too long/out of range/malformed to store). Same bucket
  // and status as the app-level validator's own 'validation_error' (routes/../validate.ts), since
  // to the client this is the same kind of failure: the submitted value didn't pass a stored rule.
  '23514': { status: 400, code: 'validation_error', message: 'Value violates a database constraint' },
  '23502': { status: 400, code: 'validation_error', message: 'Required field is missing' },
  '22001': { status: 400, code: 'validation_error', message: 'Value exceeds the maximum length' },
  '22003': { status: 400, code: 'validation_error', message: 'Numeric value out of range' },
  '22007': { status: 400, code: 'validation_error', message: 'Invalid date/time value' },
  // Generic RAISE EXCEPTION fallback. Every trigger in this codebase already sets an explicit
  // ERRCODE (state-machine/immutability triggers all raise 'check_violation' — see the migrations),
  // so P0001 should never actually fire; kept as a safety net so a future trigger that forgets to
  // set one still gets a 4xx instead of a 500.
  'P0001': { status: 400, code: 'validation_error', message: 'Database rule violation' },
  // Consequence of the statement/lock timeouts added for the app role (db.ts / the
  // role_session_timeouts migration): a query or lock wait that got cut off is a transient,
  // retryable condition from the client's point of view, not a hard failure.
  '57014': { status: 503, code: 'database_unavailable', message: 'Statement canceled (timeout)' },
  '55P03': { status: 503, code: 'database_unavailable', message: 'Lock could not be acquired in time' },
};

export function httpForDbError(
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: caller passes through whatever was thrown
  err: unknown,
): { status: number; code: string; message: string; detail?: { key: string } } | null {
  const pgCode = err instanceof DbError ? err.pgCode : (err as { code?: string } | null)?.code;
  const mapped = pgCode && PG_ERROR_MAP[pgCode] ? PG_ERROR_MAP[pgCode] : null;
  if (!mapped) return null;

  // The constraint name, when present, says exactly which rule fired — swap in a precise
  // detail.key for the ones it's safe to name everywhere (see constraint-messages.ts for the
  // reachability analysis; auth.users' own unique constraints are deliberately excluded here and
  // handled instead by routes/users.ts, the only surfaces where naming them can't leak identity
  // across tenants or roles). Unmapped/unknown constraints fall through to today's generic message.
  const constraint = err instanceof DbError ? err.constraint : undefined;
  const key = constraint ? CONSTRAINT_DETAIL_KEYS[constraint] : undefined;
  return key ? { ...mapped, detail: { key } } : mapped;
}

