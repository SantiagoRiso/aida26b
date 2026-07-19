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
  // eslint-disable-next-line no-restricted-syntax -- catch-boundary: narrows an app-thrown error of unverified shape
  err: unknown,
): { status: number; code: string; message: string; fields?: Record<string, string> } | null {
  if (!err || typeof err !== 'object') return null;
  // eslint-disable-next-line no-restricted-syntax -- fields being narrowed are themselves unverified until the typeof checks below confirm them
  const e = err as { status?: unknown; code?: unknown; message?: unknown; fields?: unknown };
  if (typeof e.status === 'number' && typeof e.code === 'string' && typeof e.message === 'string') {
    const fields = isStringRecord(e.fields) ? e.fields : undefined;
    return { status: e.status, code: e.code, message: e.message, fields };
  }
  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}
