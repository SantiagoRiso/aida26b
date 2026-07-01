import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { sendList, sendData, sendError } from '../src/status_messages';
import { assertCrudAllowed, getCrudPolicy } from '../src/routes/crud-policy';
import { sendErrorsIfInvalid, validateFullObject } from '../src/validation/validate';
import type { AuthUser } from '../src/auth';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
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
    sendList(res as unknown as Response, [{ id: '1' }], { page: 1, limit: 20, total: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ id: '1' }], meta: { page: 1, limit: 20, total: 1 } });
  });

  it('single-record / action endpoints return { success, data }', () => {
    const res = fakeRes();
    sendData(res as unknown as Response, { id: '1', name: 'x' }, 201);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: '1', name: 'x' } });
  });

  it('errors return { success: false, error: { code, message } }', () => {
    const res = fakeRes();
    sendError(res as unknown as Response, 404, 'not_found', 'nope');
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'not_found', message: 'nope' } });
  });

  it('error envelope carries a per-field map when provided', () => {
    const res = fakeRes();
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
    expect(getCrudPolicy('clients' as any)).toBeTruthy();
  });

  it('rejects unknown entities as not_found', () => {
    const check = assertCrudAllowed('does_not_exist', 'read', adminUser);
    expect(check).toMatchObject({ ok: false, status: 404, code: 'not_found' });
  });

  it('hides protected entities behind not_found (no generic reads/writes)', () => {
    for (const t of ['appointments', 'ledger_entries', 'audit_events', 'users', 'calendar_grants']) {
      const check = assertCrudAllowed(t, 'read', adminUser);
      expect(check, t).toMatchObject({ ok: false, status: 404, code: 'not_found' });
      expect(getCrudPolicy(t as any), t).toBeNull();
    }
  });

  it('rejects operations the entity does not expose', () => {
    expect(assertCrudAllowed('schedules', 'delete', adminUser)).toMatchObject({
      ok: false,
      status: 405,
      code: 'operation_not_allowed',
    });
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
    const stopped = sendErrorsIfInvalid(res as unknown as Response, result);
    expect(stopped).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.fields).toBeTypeOf('object');
    expect(res.body.error.fields.display_name).toMatch(/required/);
  });

  it('does not respond when input is valid', () => {
    const res = fakeRes();
    const result = validateFullObject('clients', {
      display_name: 'Ana',
      phone: '123',
      notes: 'x',
    });
    const stopped = sendErrorsIfInvalid(res as unknown as Response, result);
    expect(stopped).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
