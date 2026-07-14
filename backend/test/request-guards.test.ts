import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { requireUser, rejectServerDerivedFields } from '../src/routes/request-guards';
import type { AuthedRequest } from '../src/session';
import type { AuthUser } from '../src/auth';

type Envelope = {
  success: boolean;
  error?: { code: string; message: string; fields?: Record<string, string> };
};

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as Envelope | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: Envelope) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const user: AuthUser = {
  id: 1,
  username: 'admin',
  email: null,
  role: 'Admin',
  business_id: null,
  is_active: true,
  must_change_password: false,
};

describe('requireUser (per-handler fail-closed layer)', () => {
  it('responds 401 unauthorized and returns null without an authenticated user', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Request/Response — implementing the full interfaces isn't practical for a test double
    const got = requireUser({} as Request, res as unknown as Response);
    expect(got).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: { code: 'unauthorized', message: 'Authentication required' } });
  });

  it('returns the user and does not respond when authenticated', () => {
    const res = fakeRes();
    const req = { user } as AuthedRequest;
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    const got = requireUser(req, res as unknown as Response);
    expect(got).toBe(user);
    expect(res.statusCode).toBe(0);
  });
});

describe('rejectServerDerivedFields', () => {
  it('responds 422 with a per-field map when the body carries a server-stamped column', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- unvalidated HTTP body shape, same as the handlers receive
    const stopped = rejectServerDerivedFields(res as unknown as Response, 'services', {
      business_id: '1',
      name: 'x',
    } as never);
    expect(stopped).toBe(true);
    expect(res.statusCode).toBe(422);
    expect(res.body?.error?.code).toBe('server_derived_field');
    expect(res.body?.error?.fields?.business_id).toBe('must not be supplied');
  });

  it('returns false and does not respond for a clean body', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- unvalidated HTTP body shape, same as the handlers receive
    const stopped = rejectServerDerivedFields(res as unknown as Response, 'services', {
      name: 'x',
    } as never);
    expect(stopped).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
