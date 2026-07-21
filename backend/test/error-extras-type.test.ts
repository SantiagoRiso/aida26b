import { describe, it, expect } from 'vitest';
import { sendError, type HttpResponse } from '../src/status_messages';

// A minimal stand-in for Express's res: records what sendError actually wrote.
function fakeRes(): HttpResponse & { statusCode?: number; body?: unknown } {
  const res = {} as HttpResponse & { statusCode?: number; body?: unknown };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe('sendError extras typing', () => {
  it('still accepts every real extras shape (fields, detail, fields+fieldDetails, all three together)', () => {
    const withFields = fakeRes();
    sendError(withFields, 422, 'invalid_request', 'bad', { fields: { email: 'invalid' } });
    expect(withFields.body).toEqual({
      success: false,
      error: { code: 'invalid_request', message: 'bad', fields: { email: 'invalid' } },
    });

    const withDetail = fakeRes();
    sendError(withDetail, 401, 'unauthorized', 'no', { detail: { key: 'invalidCredentials' } });
    expect(withDetail.body).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'no', detail: { key: 'invalidCredentials' } },
    });

    const withAllThree = fakeRes();
    sendError(withAllThree, 400, 'validation_error', 'Validation failed', {
      fields: { email: 'invalid' },
      fieldDetails: { email: { key: 'emailFormat' } },
      detail: { key: 'validationFailed' },
    });
    expect(withAllThree.body).toEqual({
      success: false,
      error: {
        code: 'validation_error',
        message: 'Validation failed',
        fields: { email: 'invalid' },
        fieldDetails: { email: { key: 'emailFormat' } },
        detail: { key: 'validationFailed' },
      },
    });

    const withNone = fakeRes();
    sendError(withNone, 500, 'internal_error', 'oops');
    expect(withNone.body).toEqual({ success: false, error: { code: 'internal_error', message: 'oops' } });
  });

  // Regression guard for the bug this type change closes: a caller who means
  // `sendError(res, ..., { fields: someMap })` but forgets the wrapper and passes the bare map
  // must fail to compile, not silently send an error with no fields at all.
  it('rejects a bare field map at compile time (ts-expect-error becomes a real error if this regresses)', () => {
    const bareFieldMap: Record<string, string> = { email: 'invalid' };
    const res = fakeRes();
    // @ts-expect-error ErrorExtras requires a named 'fields' | 'detail' | 'fieldDetails' key;
    // a bare Record<string, string> has none of them and must not be assignable.
    sendError(res, 422, 'invalid_request', 'bad', bareFieldMap);
    expect(true).toBe(true);
  });
});
