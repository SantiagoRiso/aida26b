import { apiFetchDecoded } from '@/api/client';
import { conflict, conflictVerdict } from '@/api/contracts';
import {
  arrayOf, booleanValue, literal, nullable, numberValue, object, optional,
  stringEnum, stringValue, union,
} from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import type { ScheduleSeriesBody } from '@shared/ssot/domain/recurrence';
import type { AppointmentResponse, AppointmentSeriesResponse, VirtualOccurrence } from '@shared/ssot/query-types';
import { appointmentPaths } from '@shared/ssot/api-paths';
import { END_KIND_VALUES, FREQUENCY_VALUES, SERIES_STATUS_VALUES } from '@shared/ssot/domain/recurrence';
import { WEEKDAYS } from '@shared/ssot/domain/availability';
import type {
  EndSeriesResult, MaterializedOccurrenceResult, RelatedClientIdsResult,
  ScheduleSeriesResult as ScheduleSeriesResultContract, SeriesResult, SeriesSkip, SplitSeriesResult,
} from '@shared/ssot/contracts/appointments';

// client_user_id is NOT NULL on the appointments table — the wire always carries it.
export type Appointment = AppointmentResponse;
// created_at/updated_at cross as ISO strings, same as AppointmentRow.
export type AppointmentSeries = AppointmentSeriesResponse;
// The list endpoint unions real rows with un-materialized recurring occurrences (no row, no id
// yet). VirtualOccurrence carries only strings already, so it needs no Wire mapping.
export type ListAppointment = Appointment | VirtualOccurrence;

export const appointmentContract = object<Appointment>({
  id: stringValue,
  client_user_id: stringValue,
  professional_user_id: stringValue,
  resource_id: nullable(stringValue),
  service_id: stringValue,
  starts_at: stringValue,
  duration_minutes: numberValue,
  ends_at: stringValue,
  state: stringValue,
  name: nullable(stringValue),
  description: nullable(stringValue),
  price: stringValue,
  override_conflict: booleanValue,
  override_actor_id: optional(nullable(stringValue)),
  staff_note: optional(nullable(stringValue)),
  created_at: stringValue,
  updated_at: stringValue,
  conflict_ignored: booleanValue,
  in_conflict: optional(booleanValue),
  series_id: nullable(stringValue),
  occurrence_date: nullable(stringValue),
  is_virtual: optional(booleanValue),
  // Present on list/detail reads (joined server-side); absent on a mutation response, which
  // returns the bare RETURNING * row. Callers fall back to the FK-options lookup when missing.
  service_name: optional(stringValue),
  professional_name: optional(stringValue),
  client_name: optional(stringValue),
});

const virtualOccurrence = object<VirtualOccurrence>({
  id: literal(null), series_id: stringValue, occurrence_date: stringValue,
  client_user_id: stringValue, professional_user_id: stringValue, service_id: stringValue,
  resource_id: nullable(stringValue), starts_at: stringValue, duration_minutes: numberValue,
  price: stringValue, state: literal('scheduled'), name: literal(null), description: literal(null),
  is_virtual: literal(true), in_conflict: booleanValue,
  // Always present: expanded from an active series that is itself joined to the referenced names.
  service_name: stringValue, professional_name: stringValue, client_name: stringValue,
});
const listAppointment = union(appointmentContract, virtualOccurrence);

const appointmentSeries = object<AppointmentSeries>({
  id: stringValue, client_user_id: stringValue, professional_user_id: stringValue,
  service_id: stringValue, resource_id: nullable(stringValue),
  frequency: stringEnum(FREQUENCY_VALUES), interval: numberValue,
  weekday: nullable(stringEnum(WEEKDAYS)), week_of_month: nullable(numberValue),
  day_of_month: nullable(numberValue), start_time: stringValue, duration_minutes: numberValue,
  price_ars: stringValue, start_date: stringValue, end_kind: stringEnum(END_KIND_VALUES),
  end_count: nullable(numberValue), end_date: nullable(stringValue),
  created_by_user_id: nullable(stringValue), status: stringEnum(SERIES_STATUS_VALUES),
  created_at: stringValue, updated_at: stringValue,
});
const appointmentOrVerdict = union(appointmentContract, conflictVerdict);

export interface AppointmentListFilters {
  date_from?: string;
  date_to?: string;
  professional_user_id?: number | string;
  resource_id?: number | string;
  // Staff-only: narrow to one client's turnos. Ignored for the Client role (already self-scoped).
  client_user_id?: number | string;
  state?: string;
  // Only turnos overlapping active time-off (open + future). Role-scoped server-side.
  conflicting?: boolean;
  page?: number;
  limit?: number;
  // Ordering is server-side and allowlisted there; an unknown column falls back to the default order.
  sort?: string;
  dir?: 'asc' | 'desc';
}

export type ScheduleResult =
  | { saved: true; appointment: Appointment }
  | { saved: false; verdict: ConflictVerdict };

function toScheduleResult(data: Appointment | ConflictVerdict): ScheduleResult {
  if ('requires_override' in data) {
    return { saved: false, verdict: data };
  }
  return { saved: true, appointment: data };
}

export async function listAppointments(
  filters: AppointmentListFilters = {},
  options: { signal?: AbortSignal } = {},
): Promise<ApiResult<ListAppointment[]>> {
  const params = new URLSearchParams();
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  if (filters.professional_user_id) params.set('professional_user_id', String(filters.professional_user_id));
  if (filters.resource_id) params.set('resource_id', String(filters.resource_id));
  if (filters.client_user_id) params.set('client_user_id', String(filters.client_user_id));
  if (filters.state) params.set('state', filters.state);
  if (filters.conflicting) params.set('conflicting', 'true');
  if (filters.page && filters.page > 1) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.sort) {
    params.set('sort', filters.sort);
    params.set('dir', filters.dir ?? 'asc');
  }
  const qs = params.toString();
  return apiFetchDecoded(arrayOf(listAppointment), `${appointmentPaths.list()}${qs ? `?${qs}` : ''}`, { signal: options.signal });
}

// Distinct client ids the caller has any appointment with, in their role scope. Backs the
// "clients with a prior relationship" filter without shipping the whole appointment history.
export async function listRelatedClientIds(): Promise<ApiResult<number[]>> {
  const result = await apiFetchDecoded(object<RelatedClientIdsResult>({ client_user_ids: arrayOf(numberValue) }), appointmentPaths.relatedClients());
  if (!result.ok) return result;
  return { ok: true, data: result.data.client_user_ids, meta: result.meta };
}

export async function getAppointment(id: number | string): Promise<ApiResult<Appointment>> {
  return apiFetchDecoded(appointmentContract, appointmentPaths.detail(id));
}

export interface ScheduleBody {
  // Optional on the wire — the server first checks for scheduling conflicts (warn-first) and
  // only requires a client once it's actually about to write the row (appointments.client_user_id
  // is NOT NULL).
  client_user_id?: number | string;
  professional_user_id: number | string;
  service_id: number | string;
  resource_id?: number | string;
  date: string;
  start: string;
  duration_minutes: number;
  name?: string;
  description?: string;
  override?: boolean;
}

export async function scheduleAppointment(
  body: ScheduleBody,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetchDecoded(appointmentOrVerdict, appointmentPaths.schedule(), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

export async function approveAppointment(
  id: number | string,
  override?: boolean,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetchDecoded(appointmentOrVerdict, appointmentPaths.approve(id), {
    method: 'POST',
    body: JSON.stringify({ override: override ?? false }),
  }, { toastOnForbidden: true });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

export interface RescheduleBody {
  date?: string;
  start?: string;
  professional_user_id?: number | string;
  service_id?: number | string;
  resource_id?: number | string;
  duration_minutes?: number;
  override?: boolean;
}

export async function rescheduleAppointment(
  id: number | string,
  body: RescheduleBody,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetchDecoded(appointmentOrVerdict, appointmentPaths.reschedule(id), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

// Client-only request endpoint (no resource/override). Duration is the service default —
// clients cannot set a custom duration; the server captures the authoritative price.
export interface RequestBody {
  professional_user_id: number | string;
  service_id: number | string;
  date: string;
  start: string;
  duration_minutes: number;
  name?: string;
  description?: string;
}

export async function requestAppointment(
  body: RequestBody,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetchDecoded(appointmentOrVerdict, appointmentPaths.request(), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

export async function transitionAppointment(
  id: number | string,
  to: string,
): Promise<ApiResult<Appointment>> {
  return apiFetchDecoded(appointmentContract, appointmentPaths.transition(id), {
    method: 'POST',
    body: JSON.stringify({ to }),
  }, { toastOnForbidden: true });
}

// Acknowledge (ignored=true) or re-flag (false) a turno that overlaps time-off. Staff-only.
export async function ignoreAppointmentConflict(
  id: number | string,
  ignored = true,
): Promise<ApiResult<Appointment>> {
  return apiFetchDecoded(appointmentContract, appointmentPaths.ignoreConflict(id), {
    method: 'POST',
    body: JSON.stringify({ ignored }),
  }, { toastOnForbidden: true });
}

export interface PatchBody {
  name?: string;
  description?: string;
  staff_note?: string;
}

export async function patchAppointment(
  id: number | string,
  body: PatchBody,
): Promise<ApiResult<Appointment>> {
  return apiFetchDecoded(appointmentContract, appointmentPaths.detail(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}

export type { ScheduleSeriesBody } from '@shared/ssot/domain/recurrence';

export type { SeriesSkip } from '@shared/ssot/contracts/appointments';
export type ScheduleSeriesResult = ScheduleSeriesResultContract<AppointmentSeries>;

const seriesSkip = object<SeriesSkip>({ date: stringValue, conflicts: arrayOf(conflict) });
const scheduleSeriesResult = object<ScheduleSeriesResult>({
  series: appointmentSeries,
  preview: object({ skipped: arrayOf(seriesSkip) }),
});

export async function scheduleSeries(
  body: ScheduleSeriesBody,
): Promise<ApiResult<ScheduleSeriesResult>> {
  return apiFetchDecoded(scheduleSeriesResult, appointmentPaths.seriesCreate(), {
    method: 'POST',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}

// Idempotent — a second call for the same occurrence_date returns the same materialized row.
export async function materializeOccurrence(
  seriesId: number | string,
  occurrence_date: string,
): Promise<ApiResult<MaterializedOccurrenceResult<Appointment>>> {
  return apiFetchDecoded(object<MaterializedOccurrenceResult<Appointment>>({ appointment: appointmentContract }), appointmentPaths.seriesMaterialize(seriesId), {
    method: 'POST',
    body: JSON.stringify({ occurrence_date }),
  }, { toastOnForbidden: true });
}

// Business-scoped, staff-only, 404-hiding cross-tenant — same authz as the write routes on this
// path. Backs the reschedule-scope weekday decision and the rule editor's prefill, both of which
// need the series' current rule shape (frequency/weekday/etc.), not carried on the appointment row.
export async function getSeries(seriesId: number | string): Promise<ApiResult<AppointmentSeries>> {
  return apiFetchDecoded(appointmentSeries, appointmentPaths.seriesDetail(seriesId));
}

export async function updateSeries(
  seriesId: number | string,
  patch: Partial<ScheduleSeriesBody>,
): Promise<ApiResult<SeriesResult<AppointmentSeries>>> {
  return apiFetchDecoded(object<SeriesResult<AppointmentSeries>>({ series: appointmentSeries }), appointmentPaths.seriesDetail(seriesId), {
    method: 'PUT',
    body: JSON.stringify(patch),
  }, { toastOnForbidden: true });
}

// This-and-future split: ends the current rule the day before from_date and opens a new series
// (old identity/frozen values merged with patch) starting exactly on from_date.
export async function splitSeriesFuture(
  seriesId: number | string,
  from_date: string,
  patch: Partial<ScheduleSeriesBody>,
): Promise<ApiResult<SplitSeriesResult<AppointmentSeries>>> {
  return apiFetchDecoded(object<SplitSeriesResult<AppointmentSeries>>({
    ended: appointmentSeries, created: appointmentSeries,
  }), appointmentPaths.seriesFuture(seriesId), {
    method: 'POST',
    body: JSON.stringify({ from_date, patch }),
  }, { toastOnForbidden: true });
}

// Stops the series from from_date (defaults server-side to the series' own start_date — the whole
// series). canceled carries the BIGINT appointment ids of already-materialized occurrences that
// got canceled, same string wire type as AppointmentRow.id.
export async function endSeries(
  seriesId: number | string,
  from_date?: string,
): Promise<ApiResult<EndSeriesResult<AppointmentSeries>>> {
  return apiFetchDecoded(object<EndSeriesResult<AppointmentSeries>>({
    ended: appointmentSeries, canceled: arrayOf(stringValue),
  }), appointmentPaths.seriesEnd(seriesId), {
    method: 'POST',
    body: JSON.stringify(from_date !== undefined ? { from_date } : {}),
  }, { toastOnForbidden: true });
}
