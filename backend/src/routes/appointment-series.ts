import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext } from './business-context';
import {
  expandSeries,
  seriesRuleFromRow,
  parseRecurrenceRule,
  type RecurrenceRuleFields,
  type Conflict,
} from '../../../shared/src/ssot/domain';
import { DATE_RE, addDaysISO } from '../time';
import { assertAppointmentActionAllowed, auditInTx } from './appointment-authz';
import { withTransaction } from '../db/core';
import { isPositiveInteger } from './request-guards';
import { resolveAndLoadService, runConflictDryRun } from '../services/booking';
import {
  insertSeries,
  getSeriesById,
  updateSeriesRule,
  endSeriesAt,
  cancelFutureOccurrences,
  type InsertSeriesInput,
} from '../db/series';
import { canMaterializeOccurrence, ensureOccurrenceMaterialized } from '../services/series-materialize';
import type { AppointmentRow, AppointmentSeriesRow } from '../../../shared/src/ssot/query-types';
import type {
  EndSeriesResult, MaterializedOccurrenceResult,
  ScheduleSeriesResult, SeriesResult, SplitSeriesResult,
} from '../../../shared/src/ssot/contracts/appointments';
import { APPOINTMENT_PATTERNS } from '../../../shared/src/ssot/api-paths';

// Occurrences generated for the create-time preview span this many days from max(start_date,
// today) — bounded so a preview never dry-runs an unbounded (open-ended) series.
const SERIES_PREVIEW_DAYS = 56;

export function mountAppointmentSeriesRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter },
) {
  // Create a recurrence rule + a lock-free preview of the next SERIES_PREVIEW_DAYS window. Same
  // authz/price-freeze pipeline as /schedule; occurrences themselves are never stored (computed on
  // demand) until touched via /materialize.
  app.post(APPOINTMENT_PATTERNS.seriesCreate, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const body = req.body ?? {};
    const professionalUserId = Number(body.professional_user_id);

    const authz = await assertAppointmentActionAllowed(pool, user, professionalUserId);
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', {
        reason: authz.code,
        professional_user_id: professionalUserId,
      });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const resolved = await resolveAndLoadService(
      pool,
      businessId,
      { ...body, date: body.start_date, start: body.start_time },
      true,
      'Invalid series input',
    );
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
    }

    // client_user_id is NOT NULL on appointment_series — checked here, mirroring how /schedule
    // checks it just before the write.
    if (!isPositiveInteger(resolved.clientUserId)) {
      return sendError(res, 422, 'invalid_request', 'Invalid series input', { fields: { client_user_id: 'required' } });
    }

    const rawRule: RecurrenceRuleFields = {
      frequency: String(body.frequency ?? ''),
      interval: Number(body.interval),
      weekday: body.weekday != null ? String(body.weekday) : null,
      week_of_month: body.week_of_month != null ? Number(body.week_of_month) : null,
      day_of_month: body.day_of_month != null ? Number(body.day_of_month) : null,
      start_time: resolved.start,
      start_date: resolved.date,
      end_kind: String(body.end_kind ?? ''),
      end_count: body.end_count != null ? Number(body.end_count) : null,
      end_date: body.end_date != null ? String(body.end_date) : null,
    };
    const parsedRule = parseRecurrenceRule(rawRule);
    if ('fields' in parsedRule) {
      return sendError(res, 422, 'invalid_request', 'Invalid recurrence rule', { fields: parsedRule.fields, fieldDetails: parsedRule.fieldDetails });
    }
    const rule = parsedRule.data;

    const series = await withTransaction(pool, async (tx) => {
      const inserted = await insertSeries(tx, {
        client_user_id: String(resolved.clientUserId),
        professional_user_id: String(resolved.professionalUserId),
        service_id: String(resolved.serviceId),
        resource_id: resolved.resourceId != null ? String(resolved.resourceId) : null,
        frequency: rule.frequency,
        interval: rule.interval,
        weekday: rule.weekday,
        week_of_month: rule.week_of_month,
        day_of_month: rule.day_of_month,
        start_time: rule.start_time,
        duration_minutes: resolved.effective_duration_minutes,
        price_ars: resolved.effective_price,
        start_date: rule.start_date,
        end_kind: rule.end_kind,
        end_count: rule.end_count,
        end_date: rule.end_date,
        created_by_user_id: String(user.id),
      });
      if (!inserted) throw new Error('insertSeries: insert returned no row');
      await auditInTx(tx, user, 'appointment_series_created', 'success', Number(inserted.id), 'appointment_series');
      return inserted;
    });

    // Preview: no lock — a mere read must not serialize against real bookings. Window is bounded
    // to SERIES_PREVIEW_DAYS so an open-ended series never triggers an unbounded scan.
    const today = new Date().toISOString().slice(0, 10);
    const windowStart = series.start_date > today ? series.start_date : today;
    const windowEnd = addDaysISO(windowStart, SERIES_PREVIEW_DAYS);
    const occurrenceDates = expandSeries(seriesRuleFromRow(series), windowStart, windowEnd);

    const skipped: { date: string; conflicts: Conflict[] }[] = [];
    for (const date of occurrenceDates) {
      const dryRun = await runConflictDryRun(pool, businessId, {
        professionalUserId: Number(series.professional_user_id),
        resourceId: series.resource_id != null ? Number(series.resource_id) : undefined,
        serviceId: Number(series.service_id),
        date,
        start: series.start_time.slice(0, 5),
        durationMinutes: series.duration_minutes,
        callerIsStaff: true,
      });
      if (dryRun.ok && dryRun.verdict.conflicts.length > 0) {
        skipped.push({ date, conflicts: dryRun.verdict.conflicts });
      }
    }

    return sendData(res, { series, preview: { skipped } } satisfies ScheduleSeriesResult<AppointmentSeriesRow>, 201);
  }));

  // Touch one occurrence into an ordinary appointments row so the existing reschedule/transition
  // endpoints can act on it individually. Idempotent — a second call for the same date returns the
  // same row (see ensureOccurrenceMaterialized).
  app.post(APPOINTMENT_PATTERNS.seriesMaterialize, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const occurrenceDate = typeof req.body?.occurrence_date === 'string' ? req.body.occurrence_date : '';
    if (!DATE_RE.test(occurrenceDate)) {
      return sendError(res, 422, 'invalid_request', 'occurrence_date must be YYYY-MM-DD', { fields: { occurrence_date: 'required' } });
    }
    if (!canMaterializeOccurrence(series, occurrenceDate)) {
      return sendError(res, 422, 'invalid_request', 'occurrence_date is not part of this series', {
        fields: { occurrence_date: 'not_in_series' },
      });
    }

    const appointment = await withTransaction(pool, async (tx) => {
      const appt = await ensureOccurrenceMaterialized(tx, series, occurrenceDate);
      await auditInTx(tx, user, 'appointment_series_occurrence_materialized', 'success', Number(appt.id));
      return appt;
    });

    return sendData(res, { appointment } satisfies MaterializedOccurrenceResult<AppointmentRow>);
  }));

  // Read one series' current rule — backs the frontend's reschedule-scope weekday decision and the
  // rule editor's prefill, neither of which is carried on the appointment row itself. Mirrors the
  // PUT below: business-scoped via getSeriesById (404s, never leaking cross-tenant existence),
  // staff-only via assertAppointmentActionAllowed.
  app.get(APPOINTMENT_PATTERNS.seriesDetail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      return sendError(res, authz.status, authz.code, authz.message);
    }

    return sendData(res, series);
  }));

  // Whole-series rule edit. Price/duration stay frozen unless the patch touches a field that feeds
  // resolveBooking's precedence chain (service/resource/client/duration) — that's a deliberate
  // re-freeze, never a client-supplied number.
  app.put(APPOINTMENT_PATTERNS.seriesDetail, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};

    const rawRule: RecurrenceRuleFields = {
      frequency: body.frequency !== undefined ? String(body.frequency) : series.frequency,
      interval: body.interval !== undefined ? Number(body.interval) : series.interval,
      weekday: body.weekday !== undefined ? (body.weekday != null ? String(body.weekday) : null) : series.weekday,
      week_of_month: body.week_of_month !== undefined
        ? (body.week_of_month != null ? Number(body.week_of_month) : null)
        : series.week_of_month,
      day_of_month: body.day_of_month !== undefined
        ? (body.day_of_month != null ? Number(body.day_of_month) : null)
        : series.day_of_month,
      start_time: body.start_time !== undefined ? String(body.start_time) : series.start_time.slice(0, 5),
      start_date: body.start_date !== undefined ? String(body.start_date) : series.start_date,
      end_kind: body.end_kind !== undefined ? String(body.end_kind) : series.end_kind,
      end_count: body.end_count !== undefined ? (body.end_count != null ? Number(body.end_count) : null) : series.end_count,
      end_date: body.end_date !== undefined ? (body.end_date != null ? String(body.end_date) : null) : series.end_date,
    };
    const parsedRule = parseRecurrenceRule(rawRule);
    if ('fields' in parsedRule) {
      return sendError(res, 422, 'invalid_request', 'Invalid recurrence rule', { fields: parsedRule.fields, fieldDetails: parsedRule.fieldDetails });
    }
    const rule = parsedRule.data;

    const patch: Partial<InsertSeriesInput> = {
      frequency: rule.frequency,
      interval: rule.interval,
      weekday: rule.weekday,
      week_of_month: rule.week_of_month,
      day_of_month: rule.day_of_month,
      start_time: rule.start_time,
      start_date: rule.start_date,
      end_kind: rule.end_kind,
      end_count: rule.end_count,
      end_date: rule.end_date,
    };

    const PRICE_AFFECTING_KEYS = ['service_id', 'client_user_id', 'resource_id', 'duration_minutes', 'price_ars'];
    if (PRICE_AFFECTING_KEYS.some((k) => body[k] !== undefined)) {
      const resolved = await resolveAndLoadService(
        pool,
        businessId,
        {
          professional_user_id: series.professional_user_id,
          service_id: body.service_id !== undefined ? body.service_id : series.service_id,
          resource_id: body.resource_id !== undefined ? body.resource_id : series.resource_id,
          client_user_id: body.client_user_id !== undefined ? body.client_user_id : series.client_user_id,
          date: rule.start_date,
          start: rule.start_time,
          duration_minutes: body.duration_minutes !== undefined ? body.duration_minutes : series.duration_minutes,
        },
        true,
        'Invalid series input',
      );
      if (!resolved.ok) {
        return sendError(res, resolved.status, resolved.code, resolved.message, { fields: resolved.fields, fieldDetails: resolved.fieldDetails });
      }
      if (!isPositiveInteger(resolved.clientUserId)) {
        return sendError(res, 422, 'invalid_request', 'Invalid series input', { fields: { client_user_id: 'required' } });
      }
      patch.service_id = String(resolved.serviceId);
      patch.resource_id = resolved.resourceId != null ? String(resolved.resourceId) : null;
      patch.client_user_id = String(resolved.clientUserId);
      patch.duration_minutes = resolved.effective_duration_minutes;
      patch.price_ars = resolved.effective_price;
    }

    const updated = await withTransaction(pool, async (tx) => {
      const row = await updateSeriesRule(tx, String(id), patch);
      if (!row) throw new Error('updateSeriesRule: update returned no row');
      await auditInTx(tx, user, 'appointment_series_updated', 'success', id, 'appointment_series');
      return row;
    });

    return sendData(res, { series: updated } satisfies SeriesResult<AppointmentSeriesRow>);
  }));

  // This-and-future split: ends the current rule the day before from_date and opens a new series
  // (old identity/frozen values merged with the patch) starting exactly on from_date.
  app.post(APPOINTMENT_PATTERNS.seriesFuture, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};
    const fromDate = typeof body.from_date === 'string' ? body.from_date : '';
    if (!DATE_RE.test(fromDate)) {
      return sendError(res, 422, 'invalid_request', 'from_date must be YYYY-MM-DD', { fields: { from_date: 'required' } });
    }

    const patch = body.patch ?? {};
    const rawRule: RecurrenceRuleFields = {
      frequency: patch.frequency !== undefined ? String(patch.frequency) : series.frequency,
      interval: patch.interval !== undefined ? Number(patch.interval) : series.interval,
      weekday: patch.weekday !== undefined ? (patch.weekday != null ? String(patch.weekday) : null) : series.weekday,
      week_of_month: patch.week_of_month !== undefined
        ? (patch.week_of_month != null ? Number(patch.week_of_month) : null)
        : series.week_of_month,
      day_of_month: patch.day_of_month !== undefined
        ? (patch.day_of_month != null ? Number(patch.day_of_month) : null)
        : series.day_of_month,
      start_time: patch.start_time !== undefined ? String(patch.start_time) : series.start_time.slice(0, 5),
      start_date: fromDate,
      end_kind: patch.end_kind !== undefined ? String(patch.end_kind) : series.end_kind,
      end_count: patch.end_count !== undefined ? (patch.end_count != null ? Number(patch.end_count) : null) : series.end_count,
      end_date: patch.end_date !== undefined ? (patch.end_date != null ? String(patch.end_date) : null) : series.end_date,
    };
    const parsedRule = parseRecurrenceRule(rawRule);
    if ('fields' in parsedRule) {
      return sendError(res, 422, 'invalid_request', 'Invalid recurrence rule', { fields: parsedRule.fields, fieldDetails: parsedRule.fieldDetails });
    }
    const rule = parsedRule.data;

    const result = await withTransaction(pool, async (tx) => {
      await endSeriesAt(tx, String(id), addDaysISO(fromDate, -1));
      await auditInTx(tx, user, 'appointment_series_ended', 'success', id, 'appointment_series');
      const ended = await getSeriesById(tx, id, businessId);
      if (!ended) throw new Error('seriesFuture: ended series disappeared');

      const created = await insertSeries(tx, {
        client_user_id: series.client_user_id,
        professional_user_id: series.professional_user_id,
        service_id: series.service_id,
        resource_id: series.resource_id,
        frequency: rule.frequency,
        interval: rule.interval,
        weekday: rule.weekday,
        week_of_month: rule.week_of_month,
        day_of_month: rule.day_of_month,
        start_time: rule.start_time,
        duration_minutes: series.duration_minutes,
        price_ars: series.price_ars,
        start_date: rule.start_date,
        end_kind: rule.end_kind,
        end_count: rule.end_count,
        end_date: rule.end_date,
        created_by_user_id: String(user.id),
      });
      if (!created) throw new Error('insertSeries: insert returned no row');
      await auditInTx(tx, user, 'appointment_series_created', 'success', Number(created.id), 'appointment_series');

      return { ended, created } satisfies SplitSeriesResult<AppointmentSeriesRow>;
    });

    return sendData(res, result, 201);
  }));

  // Stop the series from a date (defaulting to its own start_date — the whole series). Ends the
  // rule so no further virtual occurrences generate at/after fromDate, and cancels any
  // already-materialized non-terminal occurrences in the same range.
  app.post(APPOINTMENT_PATTERNS.seriesEnd, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = authenticatedUser(req);
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid series id');
    }

    const series = await getSeriesById(pool, id, businessId);
    if (!series) return sendError(res, 404, 'not_found', 'Series not found');

    const authz = await assertAppointmentActionAllowed(pool, user, Number(series.professional_user_id));
    if (!authz.ok) {
      await guards.audit(req, 'appointment_action_denied', 'denied', { reason: authz.code, entity_id: id });
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const body = req.body ?? {};
    let fromDate = series.start_date;
    if (body.from_date !== undefined) {
      if (typeof body.from_date !== 'string' || !DATE_RE.test(body.from_date)) {
        return sendError(res, 422, 'invalid_request', 'from_date must be YYYY-MM-DD', { fields: { from_date: 'invalid' } });
      }
      fromDate = body.from_date;
    }

    const result = await withTransaction(pool, async (tx) => {
      await endSeriesAt(tx, String(id), addDaysISO(fromDate, -1));
      const ended = await getSeriesById(tx, id, businessId);
      if (!ended) throw new Error('seriesEnd: ended series disappeared');
      const canceledRows = await cancelFutureOccurrences(tx, String(id), fromDate);
      const canceled = canceledRows.map((r) => r.id);
      await auditInTx(tx, user, 'appointment_series_ended', 'success', id, 'appointment_series', { canceled });
      return { ended, canceled } satisfies EndSeriesResult<AppointmentSeriesRow>;
    });

    return sendData(res, result);
  }));
}
