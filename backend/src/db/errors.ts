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
export const PG_ERROR_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'conflict', message: 'Resource already exists' },
  '23503': { status: 400, code: 'invalid_request', message: 'Referenced resource does not exist' },
};

export function httpForDbError(
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: caller passes through whatever was thrown
  err: unknown,
): { status: number; code: string; message: string } | null {
  const pgCode = err instanceof DbError ? err.pgCode : (err as { code?: string } | null)?.code;
  return pgCode && PG_ERROR_MAP[pgCode] ? PG_ERROR_MAP[pgCode] : null;
}

