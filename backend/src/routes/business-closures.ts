import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import type { ColumnValue } from '../../../shared/src/types/types';
import {
  insertBusinessClosure,
  updateBusinessClosure,
  listBusinessClosures,
  findBusinessClosure,
  deleteBusinessClosure,
} from '../db/scheduling';

type AuthedRequest = Request & { user?: AuthUser };

// Audit function signature — passed in to avoid a circular import on server.ts.
type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>
) => Promise<void>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type ClosureInput = { exception_date: string; start_time: string | null; end_time: string | null; reason: string | null };
type ClosureParse = { ok: true; data: ClosureInput } | { ok: false; status: number; code: string; message: string };

// Shared create/update validation: a valid date, a time range that's both-or-neither and ordered,
// and an optional reason. Same rules the DB CHECK enforces, surfaced as friendly 400/422s.
function parseClosureBody(body: Record<string, unknown>): ClosureParse {
  const date = body.exception_date;
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'A valid exception_date (YYYY-MM-DD) is required' };
  }
  const start = body.start_time == null || body.start_time === '' ? null : String(body.start_time);
  const end = body.end_time == null || body.end_time === '' ? null : String(body.end_time);
  if ((start == null) !== (end == null)) {
    return { ok: false, status: 422, code: 'invalid_request', message: 'A time range needs both a start and an end' };
  }
  if (start != null && end != null) {
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return { ok: false, status: 422, code: 'invalid_request', message: 'Times must be HH:MM' };
    }
    if (end <= start) {
      return { ok: false, status: 422, code: 'invalid_request', message: 'The end time must be after the start time' };
    }
  }
  const reason = body.reason == null || body.reason === '' ? null : String(body.reason);
  return { ok: true, data: { exception_date: date, start_time: start, end_time: end, reason } };
}

// A business-wide closure is a schedule_exceptions row owned by the whole business — both per-owner
// columns null, business_id stamped from the session here (never the body). Because the SSOT owner
// CHECK is exactly-one-of-three, the generic CRUD engine (which never sets business_id) can only ever
// write per-owner exceptions; these owner-less closures are created/read/deleted only through here.
// Creation is Admin-only: a clinic closure is a business-level decision, not a single professional's.
export function mountBusinessClosureRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn }
) {
  app.post('/api/business-closures', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Only an Admin may manage business closures');
    }
    // Closures are tenant-bound; a super-admin (null business) has no single business to close.
    if (user.business_id == null) {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'no_business' });
      return sendError(res, 400, 'no_business', 'A business context is required to manage closures');
    }

    const parsed = parseClosureBody(req.body ?? {});
    if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message);

    const row = await insertBusinessClosure(pool, user.business_id, parsed.data);
    if (!row) return sendError(res, 500, 'internal_error', 'Internal server error');

    await guards.audit(req, 'closure_created', 'success', {
      entity_type: 'schedule_exceptions',
      entity_id: Number(row.id),
      exception_date: parsed.data.exception_date,
    });

    return sendData(res, row, 201);
  }));

  app.put('/api/business-closures/:id', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Only an Admin may manage business closures');
    }
    if (user.business_id == null) {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'no_business' });
      return sendError(res, 400, 'no_business', 'A business context is required to manage closures');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid closure id is required');
    }

    // Cross-business (or non-closure) rows are invisible — 404, never 403, to avoid leaking existence.
    const existing = await findBusinessClosure(pool, id);
    if (!existing || existing.business_id == null || Number(existing.business_id) !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Closure not found');
    }

    const parsed = parseClosureBody(req.body ?? {});
    if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message);

    const row = await updateBusinessClosure(pool, id, parsed.data);
    if (!row) return sendError(res, 500, 'internal_error', 'Internal server error');

    await guards.audit(req, 'closure_updated', 'success', {
      entity_type: 'schedule_exceptions',
      entity_id: id,
      exception_date: parsed.data.exception_date,
    });

    return sendData(res, row);
  }));

  app.get('/api/business-closures', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    // Staff-internal: which days the clinic is closed. Clients see it only through availability.
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Staff access required');
    }
    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }

    const rows = await listBusinessClosures(pool, user.business_id);
    return sendList(res, rows, { page: 1, limit: rows.length, total: rows.length });
  }));

  app.delete('/api/business-closures/:id', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Only an Admin may manage business closures');
    }
    if (user.business_id == null) {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'no_business' });
      return sendError(res, 400, 'no_business', 'A business context is required to manage closures');
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid closure id is required');
    }

    const row = await findBusinessClosure(pool, id);
    // Cross-business (or non-closure) rows are invisible — 404, never 403, to avoid leaking existence.
    if (!row || row.business_id == null || Number(row.business_id) !== user.business_id) {
      return sendError(res, 404, 'not_found', 'Closure not found');
    }

    await deleteBusinessClosure(pool, id);

    await guards.audit(req, 'closure_deleted', 'success', {
      entity_type: 'schedule_exceptions',
      entity_id: id,
    });

    return sendData(res, { id: row.id, deleted: true });
  }));
}
