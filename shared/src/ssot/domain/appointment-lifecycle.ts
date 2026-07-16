// Appointment state machine and cancellation policy. TRANSITION_MAP and APPOINTMENT_STATES are
// the two authored sources; the open/terminal sets derive from them so adding a state or edge
// updates every set at once.

export const APPOINTMENT_STATES = [
  { value: 'requested', label: { es: 'Solicitado', en: 'Requested' } },
  { value: 'scheduled', label: { es: 'Programado', en: 'Scheduled' } },
  { value: 'completed', label: { es: 'Completado', en: 'Completed' } },
  { value: 'canceled', label: { es: 'Cancelado', en: 'Canceled' } },
  { value: 'no_show', label: { es: 'Ausente', en: 'No-show' } },
  { value: 'rejected', label: { es: 'Rechazado', en: 'Rejected' } },
] as const;

export type AppointmentState = (typeof APPOINTMENT_STATES)[number]['value'];

// Valid nodes of the appointment state machine — the SSOT set for validating a state filter/value.
export const APPOINTMENT_STATE_VALUES = new Set<string>(APPOINTMENT_STATES.map((s) => s.value));

export const TRANSITION_MAP = {
  requested: ['scheduled', 'rejected', 'canceled'],
  scheduled: ['completed', 'canceled', 'no_show'],
} as const satisfies Partial<Record<AppointmentState, readonly AppointmentState[]>>;

// Used by route handlers (422) and the frontend (hide illegal actions).
export function assertValidTransition(
  from: string,
  to: string,
): { ok: true } | { ok: false; message: string } {
  const allowed = (TRANSITION_MAP as Partial<Record<string, readonly string[]>>)[from];
  if (!allowed) {
    return { ok: false, message: `State '${from}' is terminal; no transitions allowed` };
  }
  if (!allowed.includes(to)) {
    return { ok: false, message: `Transition '${from}' → '${to}' is not allowed` };
  }
  return { ok: true };
}

// Still-actionable states: a pending or upcoming turno (not yet resolved) — exactly the states
// with outgoing transitions. Read as a function in app logic and as a SQL list in
// availability/conflict queries.
export const OPEN_APPOINTMENT_STATES = Object.keys(
  TRANSITION_MAP,
) as readonly (keyof typeof TRANSITION_MAP)[];

export function isOpenAppointmentState(state: string): boolean {
  return (OPEN_APPOINTMENT_STATES as readonly string[]).includes(state);
}

// States from which no further transition is permitted (vocabulary minus open); price captured
// at booking is frozen here.
export const TERMINAL_STATES = new Set<string>(
  APPOINTMENT_STATES.map((s) => s.value).filter((v) => !(v in TRANSITION_MAP)),
);

type TerminalAppointmentState = Exclude<AppointmentState, keyof typeof TRANSITION_MAP>;

// States that void a turno — never real service history. Excluded from the calendar and from
// relationship / billing-eligibility checks. Semantic, not derivable from the graph (completed
// and no_show are also terminal but really happened); the type rejects a non-terminal entry.
export const VOID_APPOINTMENT_STATES = [
  'canceled',
  'rejected',
] as const satisfies readonly TerminalAppointmentState[];

export type VoidAppointmentState = (typeof VOID_APPOINTMENT_STATES)[number];

// Business default cancellation window when a business has none set.
export const DEFAULT_CANCELLATION_CUTOFF_HOURS = 24;

// Whether a client may cancel: a requested turno can be withdrawn anytime; a scheduled one only
// until `cutoffHours` before it starts; any other state, never. The authoritative gate (backend
// transition guard) and the portal's button state read this one rule so they cannot disagree.
export function canCancelAppointment(
  state: string,
  startsAtIso: string,
  cutoffHours: number,
  nowMs: number,
): boolean {
  if (state === 'requested') return true;
  if (state !== 'scheduled') return false;
  const hoursUntil = (new Date(startsAtIso).getTime() - nowMs) / 3_600_000;
  return hoursUntil > cutoffHours;
}

// Staff may mark a scheduled turno absent once it enters the same window in which the client can
// no longer cancel. Past appointments remain eligible.
export function canMarkNoShow(
  state: string,
  startsAtIso: string,
  cutoffHours: number,
  nowMs: number,
): boolean {
  if (state !== 'scheduled') return false;
  const hoursUntil = (new Date(startsAtIso).getTime() - nowMs) / 3_600_000;
  return hoursUntil <= cutoffHours;
}

export function canCompleteAppointment(state: string, startsAtIso: string, nowMs: number): boolean {
  return state === 'scheduled' && new Date(startsAtIso).getTime() <= nowMs;
}
