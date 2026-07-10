import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';

export interface Appointment {
  id: number;
  client_user_id: number | null;
  professional_user_id: number;
  resource_id: number | null;
  service_id: number;
  starts_at: string;
  duration_minutes: number;
  ends_at: string;
  state: string;
  name: string | null;
  description: string | null;
  price: string;
  override_conflict: boolean;
  override_actor_id: number | null;
  staff_note: string | null;
}

export interface AppointmentListFilters {
  date_from?: string;
  date_to?: string;
  professional_user_id?: number;
  resource_id?: number;
  // Staff-only: narrow to one client's turnos. Ignored for the Client role (already self-scoped).
  client_user_id?: number;
  state?: string;
  page?: number;
  limit?: number;
}

// Discriminated result so callers can branch on requires_override vs. saved appointment.
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
): Promise<ApiResult<Appointment[]>> {
  const params = new URLSearchParams();
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  if (filters.professional_user_id) params.set('professional_user_id', String(filters.professional_user_id));
  if (filters.resource_id) params.set('resource_id', String(filters.resource_id));
  if (filters.client_user_id) params.set('client_user_id', String(filters.client_user_id));
  if (filters.state) params.set('state', filters.state);
  if (filters.page && filters.page > 1) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return apiFetch<Appointment[]>(`/appointments${qs ? `?${qs}` : ''}`);
}

// Distinct client ids the caller has any appointment with, in their role scope. Backs the
// "clients with a prior relationship" filter without shipping the whole appointment history.
export async function listRelatedClientIds(): Promise<ApiResult<number[]>> {
  const result = await apiFetch<{ client_user_ids: number[] }>('/appointments/related-clients');
  if (!result.ok) return result;
  return { ok: true, data: result.data.client_user_ids, meta: result.meta };
}

export async function getAppointment(id: number): Promise<ApiResult<Appointment>> {
  return apiFetch<Appointment>(`/appointments/${id}`);
}

export interface ScheduleBody {
  // Optional on the wire — the server first checks for scheduling conflicts (warn-first) and
  // only requires a client once it's actually about to write the row (appointments.client_user_id
  // is NOT NULL).
  client_user_id?: number;
  professional_user_id: number;
  service_id: number;
  resource_id?: number;
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
  const result = await apiFetch<Appointment | ConflictVerdict>('/appointments/schedule', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

export async function approveAppointment(
  id: number,
  override?: boolean,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetch<Appointment | ConflictVerdict>(`/appointments/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ override: override ?? false }),
  });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

export interface RescheduleBody {
  date?: string;
  start?: string;
  professional_user_id?: number;
  service_id?: number;
  resource_id?: number;
  duration_minutes?: number;
  override?: boolean;
}

export async function rescheduleAppointment(
  id: number,
  body: RescheduleBody,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetch<Appointment | ConflictVerdict>(`/appointments/${id}/reschedule`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

// Client-only request endpoint (no resource/override). Duration is the service default —
// clients cannot set a custom duration; the server captures the authoritative price.
// Returns a ScheduleResult — either the saved appointment (201) or a conflict verdict (200).
export interface RequestBody {
  professional_user_id: number;
  service_id: number;
  date: string;
  start: string;
  duration_minutes: number;
  name?: string;
  description?: string;
}

export async function requestAppointment(
  body: RequestBody,
): Promise<ApiResult<ScheduleResult>> {
  const result = await apiFetch<Appointment | ConflictVerdict>('/appointments/request', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!result.ok) return result;
  return { ok: true, data: toScheduleResult(result.data), meta: result.meta };
}

export async function transitionAppointment(
  id: number,
  to: string,
): Promise<ApiResult<Appointment>> {
  return apiFetch<Appointment>(`/appointments/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to }),
  });
}

export interface PatchBody {
  name?: string;
  description?: string;
  staff_note?: string;
}

export async function patchAppointment(
  id: number,
  body: PatchBody,
): Promise<ApiResult<Appointment>> {
  return apiFetch<Appointment>(`/appointments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
