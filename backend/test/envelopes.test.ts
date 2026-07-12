import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { sendList, sendData, sendError } from '../src/status_messages';
import type { ListMeta } from '../src/status_messages';
import { assertCrudAllowed, getCrudPolicy } from '../src/routes/crud-policy';
import { sendErrorsIfInvalid, validateFullObject } from '../src/validation/validate';
import type { AuthUser } from '../src/auth';
import type { TableKey } from '../../shared/src/types/types';

type Envelope = {
  success: boolean;
  data?: Record<string, string> | Record<string, string>[];
  meta?: ListMeta;
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

const adminUser: AuthUser = {
  id: 1,
  username: 'admin',
  email: null,
  role: 'Admin',
  business_id: null,
  is_active: true,
  must_change_password: false,
};

describe('standard response envelopes', () => {
  it('list endpoints return { success, data, meta }', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    sendList(res as unknown as Response, [{ id: '1' }], { page: 1, limit: 20, total: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ id: '1' }], meta: { page: 1, limit: 20, total: 1 } });
  });

  it('single-record / action endpoints return { success, data }', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    sendData(res as unknown as Response, { id: '1', name: 'x' }, 201);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: '1', name: 'x' } });
  });

  it('errors return { success: false, error: { code, message } }', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    sendError(res as unknown as Response, 404, 'not_found', 'nope');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'not_found', message: 'nope' } });
  });

  it('error envelope carries a per-field map when provided', () => {
    const res = fakeRes();
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    sendError(res as unknown as Response, 400, 'validation_error', 'Validation failed', {
      email: 'email must be a valid email address',
    });
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'validation_error',
        message: 'Validation failed',
        fields: { email: 'email must be a valid email address' },
      },
    });
  });
});

describe('generic CRUD policy gate', () => {
  it('allows ordinary configuration entities', () => {
    const check = assertCrudAllowed('clients', 'read', adminUser);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.table).toBe('clients');
    expect(getCrudPolicy('clients')).toBeTruthy();
  });

  it('rejects unknown entities as not_found', () => {
    const check = assertCrudAllowed('does_not_exist', 'read', adminUser);
    expect(check).toMatchObject({ ok: false, status: 404, code: 'not_found' });
  });

  it('hides protected entities behind not_found (no generic reads/writes)', () => {
    for (const t of ['appointments', 'ledger_entries', 'audit_events', 'calendar_grants'] as TableKey[]) {
      const check = assertCrudAllowed(t, 'read', adminUser);
      expect(check, t).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(getCrudPolicy(t), t).toBeNull();
    }
  });

  // users carves out a narrow read-only exception (admin Usuarios screen) — writes stay
  // 404'd like every other protected entity.
  it('users stays protected for writes but allows reads for an authorized Admin', () => {
    expect(assertCrudAllowed('users', 'create', adminUser)).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(assertCrudAllowed('users', 'update', adminUser)).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(assertCrudAllowed('users', 'delete', adminUser)).toMatchObject({ ok: false, status: 404, code: 'not_found' });
    expect(assertCrudAllowed('users', 'read', adminUser).ok).toBe(true);
    expect(getCrudPolicy('users')?.read).toBe(true);
  });

  it('rejects operations the entity does not expose', () => {
    expect(assertCrudAllowed('client_professional_services', 'delete', adminUser)).toMatchObject({
      ok: false,
      status: 405,
    });
    expect(assertCrudAllowed('schedule_exceptions', 'delete', adminUser).ok).toBe(true);
  });
});

describe('validation adapter', () => {
  it('emits the standard error envelope with a fields map on invalid input', () => {
    const res = fakeRes();
    const result = validateFullObject('clients', {});
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    const stopped = sendErrorsIfInvalid(res as unknown as Response, result);
    expect(stopped).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.code).toBe('validation_error');
    expect(res.body?.error?.fields).toBeTypeOf('object');
    expect(res.body?.error?.fields?.display_name).toMatch(/required/);
  });

  it('does not respond when input is valid', () => {
    const res = fakeRes();
    const result = validateFullObject('clients', {
      display_name: 'Ana',
      phone: '123',
      dni: '12345678',
      notes: 'x',
    });
    // eslint-disable-next-line no-restricted-syntax -- partial mock of Express's Response — implementing its full interface isn't practical for a test double
    const stopped = sendErrorsIfInvalid(res as unknown as Response, result);
    expect(stopped).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
