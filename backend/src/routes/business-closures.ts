import express from 'express';
import type { RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext, belongsToBusiness } from './business-context';
import {
  insertBusinessClosure,
  updateBusinessClosure,
  listBusinessClosures,
  findBusinessClosure,
  deleteBusinessClosure,
} from '../db/scheduling';
import { parseTimeOffRange } from '../services/scheduling';
import { CLOSURE_PATTERNS } from '../../../shared/src/ssot/api-paths';

type ClosureInput = { exception_date: string; start_time: string | null; end_time: string | null; reason: string | null };
type ClosureParse = { ok: true; data: ClosureInput } | { ok: false; status: number; code: string; message: string };

// Shared create/update validation: the common time-off range rules plus an optional reason.
// eslint-disable-next-line no-restricted-syntax -- Express request bodies are untrusted until this parser validates them.
function parseClosureBody(body: Record<string, unknown>): ClosureParse {
  const parsed = parseTimeOffRange(
    { date: body.exception_date, start: body.start_time, end: body.end_time },
    { status: 400, message: 'A valid exception_date (YYYY-MM-DD) is required' },
  );
  if (!parsed.ok) return parsed;
  const reason = body.reason == null || body.reason === '' ? null : String(body.reason);
  return { ok: true, data: { exception_date: parsed.date, start_time: parsed.start, end_time: parsed.end, reason } };
}

// A business-wide closure is a schedule_exceptions row owned by the whole business — both per-owner
// columns null, business_id stamped from the session here (never the body). Because the SSOT owner
// CHECK is exactly-one-of-three, the generic CRUD engine (which never sets business_id) can only ever
// write per-owner exceptions; these owner-less closures are created/read/deleted only through here.
// Creation is Admin-only: a clinic closure is a business-level decision, not a single professional's.
export function mountBusinessClosureRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter }
) {
  app.post(CLOSURE_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role !== 'Admin') {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Only an Admin may manage business closures');
    }
    // Closures are tenant-bound; a super-admin (null business) has no single business to close.
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const parsed = parseClosureBody(req.body ?? {});
    if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message);

    const row = await insertBusinessClosure(pool, businessId, parsed.data);
    if (!row) return sendError(res, 500, 'internal_error', 'Internal server error');

    await guards.audit(req, 'closure_created', 'success', {
      entity_type: 'schedule_exceptions',
      entity_id: Number(row.id),
      exception_date: parsed.data.exception_date,
    });

    return sendData(res, row, 201);
  }));

  app.put(CLOSURE_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role !== 'Admin') {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Only an Admin may manage business closures');
    }
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid closure id is required');
    }

    const existing = await findBusinessClosure(pool, id);
    if (!belongsToBusiness(existing, businessId)) {
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

  app.get(CLOSURE_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    // Staff-internal: which days the clinic is closed. Clients see it only through availability.
    if (user.role === 'Client') {
      return sendError(res, 403, 'forbidden', 'Staff access required');
    }
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const rows = await listBusinessClosures(pool, businessId);
    return sendList(res, rows, { page: 1, limit: rows.length, total: rows.length });
  }));

  app.delete(CLOSURE_PATTERNS.detail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role !== 'Admin') {
      await guards.audit(req, 'closure_denied', 'denied', { reason: 'role_forbidden' });
      return sendError(res, 403, 'forbidden', 'Only an Admin may manage business closures');
    }
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid closure id is required');
    }

    const row = await findBusinessClosure(pool, id);
    if (!belongsToBusiness(row, businessId)) {
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
