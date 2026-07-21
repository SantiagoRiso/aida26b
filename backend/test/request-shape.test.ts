import http from 'node:http';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import {
  parseRequestFields,
  requireRequestFields,
  requireIdParam,
  requestIssue,
  type RequestSpec,
} from '../src/routes/request-guards';
import { mountAppointmentRoutes } from '../src/routes/appointments';
import { mountSchedulingRoutes } from '../src/routes/scheduling';
import { DATE_RE } from '../src/time';
import type { AuthUser } from '../src/auth';
import type { ApiErrorEnvelope } from '../../shared/src/ssot/envelope';

type Envelope = ApiErrorEnvelope | { success: true; data: object };

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as Envelope | undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: Envelope) { res.body = payload; return res; },
  };
  return res;
}

function errorOf(body: Envelope | undefined | null) {
  if (!body || body.success !== false) throw new Error('expected an error envelope');
  return body.error;
}

describe('request-shape engine: key + param emission', () => {
  const spec = {
    id: { kind: 'id', required: true },
    date: { kind: 'isoDate' },
    when: { kind: 'dateOrIso' },
    at: { kind: 'timeOfDay' },
    flag: { kind: 'boolean' },
    note: { kind: 'text', maxLength: 4 },
    state: { kind: 'enum', values: ['scheduled', 'canceled'] },
    owner: { kind: 'pattern', pattern: /^(prof|res):(\d+)$/, key: 'ownerToken' },
  } as const satisfies RequestSpec;

  it('names a missing required field with the same `required` key the column validator uses', () => {
    const { issues } = parseRequestFields(spec, {});
    expect(issues.id.issue).toEqual({ key: 'required' });
    expect(issues.id.message).toBe('id is required');
  });

  it('emits one stable key per kind, never prose-only', () => {
    const { issues } = parseRequestFields(spec, {
      id: '0',
      date: '20-07-2026',
      when: 'yesterday',
      at: '25:00',
      flag: 'yes',
      owner: 'prof-7',
    });
    expect(issues.id.issue.key).toBe('positiveInteger');
    expect(issues.date.issue.key).toBe('dateFormat');
    expect(issues.when.issue.key).toBe('dateFormat');
    expect(issues.at.issue.key).toBe('timeOfDayFormat');
    expect(issues.flag.issue.key).toBe('notBoolean');
    // A pattern names its own constraint rather than reporting an anonymous bad format.
    expect(issues.owner.issue.key).toBe('ownerToken');
  });

  it('carries interpolation params for the rules that have a bound', () => {
    const { issues } = parseRequestFields(spec, { id: 1, note: 'far too long', state: 'nope' });
    expect(issues.note.issue).toEqual({ key: 'maxLength', params: { max: 4 } });
    expect(issues.state.issue).toEqual({ key: 'notInOptions', params: { options: 'scheduled, canceled' } });
  });

  it('coerces a valid shape and leaves omitted optional fields undefined', () => {
    const { values, issues } = parseRequestFields(spec, {
      id: '42',
      date: '2026-07-20',
      at: '09:30',
      flag: 'true',
      state: 'scheduled',
      owner: 'res:3',
    });
    expect(issues).toEqual({});
    expect(values).toEqual({
      id: 42,
      date: '2026-07-20',
      when: undefined,
      at: '09:30',
      flag: true,
      note: undefined,
      state: 'scheduled',
      owner: 'res:3',
    });
  });

  it('reads the first value of a repeated query param rather than failing on the array', () => {
    const { values, issues } = parseRequestFields({ id: { kind: 'id', required: true } } as const, { id: ['7', '9'] });
    expect(issues).toEqual({});
    expect(values.id).toBe(7);
  });

  it('treats a blank string as "not supplied" except for free text, where clearing is a real edit', () => {
    const { values, issues } = parseRequestFields(
      { date: { kind: 'isoDate' }, note: { kind: 'text' } } as const,
      { date: '', note: '' },
    );
    expect(issues).toEqual({});
    expect(values.date).toBeUndefined();
    expect(values.note).toBe('');
  });

  it('reuses the ISO date regex rather than restating it', () => {
    const bad = ['2026-7-20', '2026/07/20', '2026-07-20T10:00:00Z'];
    for (const value of bad) {
      expect(DATE_RE.test(value)).toBe(false);
      expect(parseRequestFields({ d: { kind: 'isoDate' } } as const, { d: value }).issues.d.issue.key).toBe('dateFormat');
    }
  });
});

describe('request-shape guards', () => {
  const spec = { date: { kind: 'isoDate', required: true } } as const satisfies RequestSpec;

  it('requireRequestFields answers 422 with both projections: English fields and keyed fieldDetails', () => {
    const res = fakeRes();
    expect(requireRequestFields(res, spec, { date: 'nope' }, 'Invalid thing')).toBeNull();
    expect(res.statusCode).toBe(422);
    const error = errorOf(res.body);
    expect(error.code).toBe('invalid_request');
    expect(error.message).toBe('Invalid thing');
    expect(error.fields).toEqual({ date: 'date must be YYYY-MM-DD' });
    expect(error.fieldDetails).toEqual({ date: { key: 'dateFormat' } });
  });

  it('requireRequestFields returns the coerced values and does not respond on a good shape', () => {
    const res = fakeRes();
    expect(requireRequestFields(res, spec, { date: '2026-07-20' }, 'Invalid thing')).toEqual({ date: '2026-07-20' });
    expect(res.statusCode).toBe(0);
  });

  it('a malformed :id is a top-level detail, not a field error pinned to an off-screen field', () => {
    const res = fakeRes();
    expect(requireIdParam(res, 'abc', 'appointment')).toBeNull();
    expect(res.statusCode).toBe(422);
    const error = errorOf(res.body);
    expect(error.message).toBe('Invalid appointment id');
    expect(error.detail).toEqual({ key: 'invalidId' });
    expect(error.fields).toBeUndefined();
  });

  it('requestIssue omits params entirely when a rule has none, matching the column validator', () => {
    expect(requestIssue('ownerToken', 'must be prof:<id> or res:<id>').issue).toEqual({ key: 'ownerToken' });
    expect(requestIssue('dateRangeTooLong', 'too long', { max: 42 }).issue).toEqual({
      key: 'dateRangeTooLong',
      params: { max: 42 },
    });
  });
});

// These routes reject a malformed request before touching the database, so the pool is never used.
describe('converted workflow routes reject a malformed request with per-field keys', () => {
  let server: http.Server;
  let baseUrl: string;
  const user: AuthUser = {
    id: 1, username: 'staff', email: null, role: 'Admin',
    business_id: 1, is_active: true, must_change_password: false,
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: AuthUser }).user = user;
      next();
    });
    const unusedPool = {} as Pool;
    const guards = {
      auth: ((_req, _res, next) => next()) as express.RequestHandler,
      passwordReady: ((_req, _res, next) => next()) as express.RequestHandler,
      audit: async () => {},
    };
    mountAppointmentRoutes(app, unusedPool, guards);
    mountSchedulingRoutes(app, unusedPool, guards);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  async function call(method: 'GET' | 'POST', path: string, body?: object) {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${baseUrl}${path}`, init);
    return { status: response.status, body: JSON.parse(await response.text()) as Envelope };
  }

  it('GET /api/appointments names every bad filter at once, by key', async () => {
    const res = await call('GET', '/api/appointments?date_from=nope&client_user_id=-3&state=napping&conflicting=maybe');
    expect(res.status).toBe(422);
    const error = errorOf(res.body);
    expect(error.code).toBe('invalid_request');
    expect(error.fieldDetails?.date_from).toEqual({ key: 'dateFormat' });
    expect(error.fieldDetails?.client_user_id).toEqual({ key: 'positiveInteger' });
    expect(error.fieldDetails?.state.key).toBe('notInOptions');
    expect(error.fieldDetails?.state.params?.options).toContain('scheduled');
    expect(error.fieldDetails?.conflicting).toEqual({ key: 'notBoolean' });
  });

  it('GET /api/availability reports the owner token and the range rules together', async () => {
    const res = await call('GET', '/api/availability?owner=prof7&date=2026-07-20&date_from=2026-07-20&date_to=2026-07-19');
    expect(res.status).toBe(422);
    const error = errorOf(res.body);
    expect(error.fieldDetails?.owner).toEqual({ key: 'ownerToken' });
    expect(error.fieldDetails?.date).toEqual({ key: 'notAllowedWithRange' });
    expect(error.fieldDetails?.date_to).toEqual({ key: 'dateRangeOrder' });
  });

  it('GET /api/availability caps the expanded range with an interpolated bound', async () => {
    const res = await call('GET', '/api/availability?owner=prof:7&date_from=2026-01-01&date_to=2026-06-01');
    expect(res.status).toBe(422);
    expect(errorOf(res.body).fieldDetails?.date_to).toEqual({ key: 'dateRangeTooLong', params: { max: 42 } });
  });

  it('GET /api/booking-window keys its required ids instead of a bare prose map', async () => {
    const res = await call('GET', '/api/booking-window?professional=abc');
    expect(res.status).toBe(422);
    const error = errorOf(res.body);
    expect(error.fieldDetails?.professional).toEqual({ key: 'positiveInteger' });
    expect(error.fieldDetails?.service).toEqual({ key: 'required' });
  });

  it('POST /api/appointments/:id/transition rejects an unknown target state by key', async () => {
    const res = await call('POST', '/api/appointments/5/transition', { to: 'napping' });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).fieldDetails?.to.key).toBe('notInOptions');
  });

  it('POST /api/appointments/:id/transition rejects a missing target state as required', async () => {
    const res = await call('POST', '/api/appointments/5/transition', {});
    expect(res.status).toBe(422);
    expect(errorOf(res.body).fieldDetails?.to).toEqual({ key: 'required' });
  });

  it('a non-numeric :id never reaches the database', async () => {
    const res = await call('POST', '/api/appointments/abc/transition', { to: 'canceled' });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).detail).toEqual({ key: 'invalidId' });
  });
});
