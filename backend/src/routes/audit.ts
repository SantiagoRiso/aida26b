import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { listAuditEvents, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT, AUDIT_FILTER_FIELDS } from '../db/audit';
import type { AuditScope, AuditFilterField } from '../db/audit';
import { AUDIT_OUTCOME_VALUES } from '../../../shared/src/ssot/domain';
import { DATE_OR_ISO_RE } from '../time';
import { parsePagination, parseListSort } from './pagination';
import { parseListRequest } from './list-request';
import { AUDIT_PATTERNS } from '../../../shared/src/ssot/api-paths';

export function mountAuditRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter },
) {
  // Scope comes from the session, never the request: a tenant Admin reads their own business only,
  // a super-admin reads every tenant. Tenantless events (a login attempt on a username nobody holds)
  // are attempts on the system, not on any tenant, so only the super-admin sees them.
  app.get(AUDIT_PATTERNS.list, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      return sendError(res, 403, 'forbidden', 'Admin access required');
    }

    const scope: AuditScope = user.business_id == null
      ? { kind: 'all' }
      : { kind: 'tenant', businessId: user.business_id };

    // Filters speak the shared `filter_` grammar, the same vocabulary the sort and the URL round-trip
    // already use; only the endpoint's own allowlisted field names survive, and every value below
    // reaches SQL as a bind parameter.
    const spec = parseListRequest(req.query);
    const filterValues = new Map<AuditFilterField, { value: string; negated: boolean }>();
    for (const entry of spec.filters) {
      if (!(AUDIT_FILTER_FIELDS as readonly string[]).includes(entry.field)) continue;
      const meaningful = entry.values.filter((v) => v.value !== '');
      if (meaningful.length === 0) continue;
      // One value per field here: a set (`a|b`) or a repeated param would silently drop all but the
      // first, answering a narrower query than was asked. Reject instead.
      if (meaningful.length > 1) {
        return sendError(res, 422, 'invalid_request', `Only one value is allowed for ${entry.field}`);
      }
      filterValues.set(entry.field as AuditFilterField, meaningful[0]);
    }

    const entityType = filterValues.get('entity_type');
    const eventType = filterValues.get('event_type');

    let actorUserId: { value: number; negated: boolean } | undefined;
    const actorRaw = filterValues.get('actor_user_id');
    if (actorRaw !== undefined) {
      const actorId = Number(actorRaw.value);
      if (Number.isInteger(actorId) && actorId > 0) actorUserId = { value: actorId, negated: actorRaw.negated };
    }

    let outcome: { value: string; negated: boolean } | undefined;
    const outcomeRaw = filterValues.get('outcome');
    if (outcomeRaw !== undefined) {
      if (!AUDIT_OUTCOME_VALUES.has(outcomeRaw.value)) {
        return sendError(res, 422, 'invalid_request', 'Unknown outcome');
      }
      outcome = outcomeRaw;
    }

    // The shared range grammar on a date column: `min,max`, either bound optional, a bare value
    // naming a single day (both bounds equal). Day bounds resolve in the business timezone downstream.
    let dateFrom: string | undefined;
    let dateTo: string | undefined;
    const createdAtRaw = filterValues.get('created_at');
    if (createdAtRaw !== undefined) {
      if (createdAtRaw.negated) {
        return sendError(res, 422, 'invalid_request', 'Negation is not supported on created_at');
      }
      const commaIdx = createdAtRaw.value.indexOf(',');
      const fromPart = commaIdx >= 0 ? createdAtRaw.value.slice(0, commaIdx) : createdAtRaw.value;
      const toPart = commaIdx >= 0 ? createdAtRaw.value.slice(commaIdx + 1) : createdAtRaw.value;
      if (fromPart !== '') {
        if (!DATE_OR_ISO_RE.test(fromPart)) {
          return sendError(res, 422, 'invalid_request', 'created_at lower bound must be a date (YYYY-MM-DD) or ISO timestamp');
        }
        dateFrom = fromPart;
      }
      if (toPart !== '') {
        if (!DATE_OR_ISO_RE.test(toPart)) {
          return sendError(res, 422, 'invalid_request', 'created_at upper bound must be a date (YYYY-MM-DD) or ISO timestamp');
        }
        dateTo = toPart;
      }
    }

    const { limit, page, offset } = parsePagination(req.query);
    const sort = parseListSort(req.query, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT);

    const { rows, total } = await listAuditEvents(pool, {
      scope,
      sort,
      entityType,
      actorUserId,
      eventType,
      outcome,
      dateFrom,
      dateTo,
      limit,
      offset,
    });

    return sendList(res, rows, { page, limit, total });
  }));
}
