export class DbError extends Error {
  constructor(
    message: string,
    public readonly pgCode?: string,
    public readonly cause?: unknown,
    // pg constraint name — lets callers distinguish which unique/FK constraint fired.
    public readonly constraint?: string,
  ) {
    super(message);
    this.name = 'DbError';
  }

  static from(e: unknown): DbError {
    if (e instanceof DbError) return e;
    const err = e as { message?: string; code?: string; constraint?: string } | null;
    const code = typeof err?.code === 'string' ? err.code : undefined;
    const constraint = typeof err?.constraint === 'string' ? err.constraint : undefined;
    return new DbError(err?.message ?? 'Database error', code, e, constraint);
  }
}

// SQLSTATE → HTTP. Withheld codes fall through to a generic 500.
export const PG_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'conflict', message: 'Resource already exists' },
  '23503': { status: 400, code: 'invalid_request', message: 'Referenced resource does not exist' },
};

export function httpForDbError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  const pgCode = err instanceof DbError ? err.pgCode : (err as { code?: string } | null)?.code;
  return pgCode && PG_ERROR_MAP[pgCode] ? PG_ERROR_MAP[pgCode] : null;
}

// Build an app error that carries its own HTTP mapping, for throwing from inside a transaction or
// service where returning a discriminated result isn't practical (guardRoute maps it via
// httpForStructuredError). Survives withTransaction, which rethrows the original error.
export function httpError(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): Error {
  const err = new Error(message) as Error & { status: number; code: string; fields?: Record<string, string> };
  err.status = status;
  err.code = code;
  if (fields) err.fields = fields;
  return err;
}

// A caught error carrying an explicit HTTP mapping (from httpError, or the conflict recheck when an
// owner disappears mid-transaction). Distinct from DbError; recognized by a numeric status.
export function httpForStructuredError(
  err: unknown,
): { status: number; code: string; message: string; fields?: Record<string, string> } | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: unknown; code?: unknown; message?: unknown; fields?: unknown };
  if (typeof e.status === 'number' && typeof e.code === 'string' && typeof e.message === 'string') {
    const fields =
      e.fields && typeof e.fields === 'object' ? (e.fields as Record<string, string>) : undefined;
    return { status: e.status, code: e.code, message: e.message, fields };
  }
  return null;
}
