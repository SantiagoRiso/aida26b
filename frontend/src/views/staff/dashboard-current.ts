import type { Appointment } from '@/api/appointments';
import type { Role } from '@shared/types/roles';
import type { AppointmentState } from '@shared/ssot/domain/appointment-lifecycle';

export const CURRENT_LEAD_MS = 5 * 60 * 1000;

// The card appears 5 min before start and stays until the turno is resolved
// (completed/no_show) — an unattended session must never expire silently.
export function isCurrent(
  appt: Pick<Appointment, 'state' | 'starts_at'>,
  at: Date,
): boolean {
  if (appt.state !== 'scheduled') return false;
  return at.getTime() >= new Date(appt.starts_at).getTime() - CURRENT_LEAD_MS;
}

// Attendance can't be marked before the turno starts (backend rejects it).
export function canSettle(
  appt: Pick<Appointment, 'starts_at'>,
  at: Date,
): boolean {
  return at.getTime() >= new Date(appt.starts_at).getTime();
}

export type SettleAction = 'paid' | 'unpaid' | 'absent';

// "absent" marks a no_show and never charges; paid/unpaid both complete the turno.
export function transitionFor(action: SettleAction): Extract<AppointmentState, 'completed' | 'no_show'> {
  return action === 'absent' ? 'no_show' : 'completed';
}

// The card belongs to whoever runs the session: the appointment's own professional,
// or a receptionist (their appointment list is already server-scoped to calendars
// they hold grants on). Admins oversee, they don't settle turnos — no card.
export function showsCurrentCard(
  user: { id: number; role: Role } | null,
  appt: Pick<Appointment, 'professional_user_id'>,
): boolean {
  if (!user || user.role === 'Admin') return false;
  if (user.role === 'Receptionist') return true;
  return user.role === 'Professional' && String(user.id) === appt.professional_user_id;
}
