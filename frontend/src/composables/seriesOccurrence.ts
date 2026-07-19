import { materializeOccurrence } from '@/api/appointments';
import type { Appointment, ListAppointment } from '@/api/appointments';
import type { VirtualOccurrence } from '@shared/ssot/query-types';

// A virtual occurrence has no row yet — acting on it (reschedule/complete/no-show/cancel) needs a
// real id first. Materializing is idempotent, so this is safe to call unconditionally; an
// already-real appointment (including a non-series one) passes through unchanged. Returns null
// only if materialization itself fails, so callers can surface a single error path.
export async function resolveActionable(appt: Appointment): Promise<Appointment | null> {
  if (!appt.is_virtual || appt.series_id == null || appt.occurrence_date == null) return appt;
  const result = await materializeOccurrence(appt.series_id, appt.occurrence_date);
  return result.ok ? result.data.appointment : null;
}

export function isVirtualOccurrence(item: ListAppointment): item is VirtualOccurrence {
  return item.is_virtual === true;
}

// A virtual occurrence has no id yet (materializes on first action) — FullCalendar and Vue list
// keys need a stable one regardless. Deterministic from the occurrence's own identity so re-fetches
// (and the drag/booked-slot indexing keyed off appointments.value) never see it "move".
export function appointmentKey(item: ListAppointment): string {
  return isVirtualOccurrence(item) ? `virtual:${item.series_id}:${item.occurrence_date}` : item.id;
}

// Normalizes a list item into the shape the rest of the app already renders (calendar mapping,
// drag, the detail panel) — a virtual occurrence has no row for a handful of fields, filled here
// with inert defaults. Acting on the result (resolveActionable, above) materializes the real row.
export function toDisplayAppointment(item: ListAppointment): Appointment {
  if (!isVirtualOccurrence(item)) return item;
  const ends_at = new Date(new Date(item.starts_at).getTime() + item.duration_minutes * 60000).toISOString();
  return {
    ...item,
    id: appointmentKey(item),
    ends_at,
    override_conflict: false,
    override_actor_id: null,
    staff_note: null,
    created_at: item.starts_at,
    updated_at: item.starts_at,
    conflict_ignored: false,
  };
}
