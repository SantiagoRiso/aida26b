import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import type { AppointmentRow, Wire } from '@shared/ssot/query-types';
import { appointmentPaths } from '@shared/ssot/api-paths';

// client_user_id is NOT NULL on the appointments table — the wire always carries it.
export type Appointment = Wire<AppointmentRow>;

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
}

export type ScheduleResult =
  | { saved: true; appointment: Appointment }
  | { saved: false; verdict: ConflictVerdict };

function toScheduleResult(data: Appointment | ConflictVerdict): ScheduleResult {
  if ('requires_override' in data) {
    return { saved: false, verdict: data as ConflictVerdict };
  }
  return { saved: true, appointment: data as Appointment };
}

export async function listAppointments(
  filters: AppointmentListFilters = {},
  options: { signal?: AbortSignal } = {},
): Promise<ApiResult<Appointment[]>> {
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
  const qs = params.toString();
  return apiFetch<Appointment[]>(`${appointmentPaths.list()}${qs ? `?${qs}` : ''}`, { signal: options.signal });
}

// Distinct client ids the caller has any appointment with, in their role scope. Backs the
// "clients with a prior relationship" filter without shipping the whole appointment history.
export async function listRelatedClientIds(): Promise<ApiResult<number[]>> {
  const result = await apiFetch<{ client_user_ids: number[] }>(appointmentPaths.relatedClients());
  if (!result.ok) return result;
  return { ok: true, data: result.data.client_user_ids, meta: result.meta };
}

export async function getAppointment(id: number | string): Promise<ApiResult<Appointment>> {
  return apiFetch<Appointment>(appointmentPaths.detail(id));
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
  const result = await apiFetch<Appointment | ConflictVerdict>(appointmentPaths.schedule(), {
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
  const result = await apiFetch<Appointment | ConflictVerdict>(appointmentPaths.approve(id), {
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
  const result = await apiFetch<Appointment | ConflictVerdict>(appointmentPaths.reschedule(id), {
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
  const result = await apiFetch<Appointment | ConflictVerdict>(appointmentPaths.request(), {
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
  return apiFetch<Appointment>(appointmentPaths.transition(id), {
    method: 'POST',
    body: JSON.stringify({ to }),
  }, { toastOnForbidden: true });
}

// Acknowledge (ignored=true) or re-flag (false) a turno that overlaps time-off. Staff-only.
export async function ignoreAppointmentConflict(
  id: number | string,
  ignored = true,
): Promise<ApiResult<Appointment>> {
  return apiFetch<Appointment>(appointmentPaths.ignoreConflict(id), {
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
  return apiFetch<Appointment>(appointmentPaths.detail(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, { toastOnForbidden: true });
}
