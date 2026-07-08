import type { TableStructure } from '../../types/types';
import { pkColumn } from './business';

// States from which no further transition is permitted; price captured at booking is frozen here.
export const TERMINAL_STATES = new Set(['completed', 'canceled', 'no_show', 'rejected']);

// Legal outgoing transitions per source state. Terminal states have no entry.
export const TRANSITION_MAP: Record<string, readonly string[]> = {
  requested: ['scheduled', 'rejected', 'canceled'],
  scheduled: ['completed', 'canceled', 'no_show'],
};

// Returns { ok: true } on a valid edge, or { ok: false, message } otherwise.
// Used by route handlers (422) and the frontend (hide illegal actions).
export function assertValidTransition(
  from: string,
  to: string,
): { ok: true } | { ok: false; message: string } {
  const allowed = TRANSITION_MAP[from];
  if (!allowed) {
    return { ok: false, message: `State '${from}' is terminal; no transitions allowed` };
  }
  if (!allowed.includes(to)) {
    return { ok: false, message: `Transition '${from}' → '${to}' is not allowed` };
  }
  return { ok: true };
}

const APPOINTMENT_STATES = [
  { value: 'requested', label: { es: 'Solicitado', en: 'Requested' } },
  { value: 'scheduled', label: { es: 'Agendado', en: 'Scheduled' } },
  { value: 'completed', label: { es: 'Completado', en: 'Completed' } },
  { value: 'canceled', label: { es: 'Cancelado', en: 'Canceled' } },
  { value: 'no_show', label: { es: 'No Asistió', en: 'No Show' } },
  { value: 'rejected', label: { es: 'Rechazado', en: 'Rejected' } },
] as const;

// Valid nodes of the appointment state machine — the SSOT set for validating a state filter/value.
export const APPOINTMENT_STATE_VALUES = new Set<string>(APPOINTMENT_STATES.map((s) => s.value));

export const schedulingTables = {
  // Weekly pattern for exactly one owner (professional XOR resource, DB-enforced). business_id
  // is derived via the owner. No DELETE grant, so delete is withheld.
  schedules: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'user_id', labelField: 'display_name' },
        referencesUserRole: 'Professional',
      },
      resource_id: {
        type: 'string',
        label: { es: 'Recurso', en: 'Resource' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      weekly: {
        type: 'string',
        label: { es: 'Horario Semanal', en: 'Weekly Hours' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Horario', en: 'Schedule' },
    title: { es: 'Horarios', en: 'Schedules' },
    addButtonLabel: { es: 'Agregar Horario', en: 'Add Schedule' },
    crud: { create: true, read: true, update: true, delete: false },
    // Business is derived via whichever owner is set (professional or resource).
    businessJoin: {
      paths: [
        { parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' },
        { parentTable: 'resources',  localFk: 'resource_id',           parentPk: 'id' },
      ],
    },
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist', 'Client'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: [],
    },
  } satisfies TableStructure,

  schedule_exceptions: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'user_id', labelField: 'display_name' },
        referencesUserRole: 'Professional',
      },
      resource_id: {
        type: 'string',
        label: { es: 'Recurso', en: 'Resource' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      exception_date: {
        type: 'string',
        label: { es: 'Fecha', en: 'Date' },
        input: 'date',
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      is_unavailable: {
        type: 'boolean',
        label: { es: 'No Disponible', en: 'Unavailable' },
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      start_time: {
        type: 'string',
        label: { es: 'Hora Inicio', en: 'Start Time' },
        validator: { nullable: true, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', patternMessage: 'must be HH:MM' },
        filterable: false,
        sortable: false,
      },
      end_time: {
        type: 'string',
        label: { es: 'Hora Fin', en: 'End Time' },
        validator: { nullable: true, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', patternMessage: 'must be HH:MM' },
        filterable: false,
        sortable: false,
      },
      // Required only for a changed-hours "available" exception; null for full-day/blocked (DB CHECK).
      granularity_minutes: {
        type: 'number',
        label: { es: 'Granularidad (min)', en: 'Granularity (min)' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      reason: {
        type: 'string',
        label: { es: 'Motivo', en: 'Reason' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Excepción de Horario', en: 'Schedule Exception' },
    title: { es: 'Excepciones de Horario', en: 'Schedule Exceptions' },
    addButtonLabel: { es: 'Agregar Excepción', en: 'Add Exception' },
    crud: { create: true, read: true, update: true, delete: true },
    // Business is derived via whichever owner is set (professional or resource).
    businessJoin: {
      paths: [
        { parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' },
        { parentTable: 'resources',  localFk: 'resource_id',           parentPk: 'id' },
      ],
    },
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist', 'Client'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin', 'Professional', 'Receptionist'],
    },
  } satisfies TableStructure,

  // The appointment lifecycle is workflow-owned. ends_at is trigger-maintained and price is
  // captured at booking. business_id is derived.
  appointments: {
    columns: {
      id: pkColumn,
      client_user_id: {
        type: 'string',
        label: { es: 'Cliente', en: 'Client' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'clients', valueField: 'user_id', labelField: 'display_name' },
      },
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'user_id', labelField: 'display_name' },
      },
      resource_id: {
        type: 'string',
        label: { es: 'Recurso', en: 'Resource' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      service_id: {
        type: 'string',
        label: { es: 'Servicio', en: 'Service' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
      },
      starts_at: {
        type: 'date',
        label: { es: 'Inicio', en: 'Start' },
        input: 'date',
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      duration_minutes: {
        type: 'number',
        label: { es: 'Duración (min)', en: 'Duration (min)' },
        input: 'number',
        validator: { required: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      ends_at: {
        type: 'date',
        label: { es: 'Fin', en: 'End' },
        editable: false,
        filterable: false,
        sortable: true,
      },
      state: {
        type: 'string',
        label: { es: 'Estado', en: 'State' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: APPOINTMENT_STATES.map((s) => ({ value: s.value, label: s.label })),
      },
      name: {
        type: 'string',
        label: { es: 'Título', en: 'Title' },
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      description: {
        type: 'string',
        label: { es: 'Descripción', en: 'Description' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
      price: {
        type: 'string',
        label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
        validator: {
          required: true,
          pattern: '^\\d+(\\.\\d{1,2})?$',
          patternMessage: 'must be a non-negative amount',
        },
        filterable: false,
        sortable: true,
      },
      override_conflict: {
        type: 'boolean',
        label: { es: 'Conflicto Forzado', en: 'Conflict Override' },
        filterable: true,
        sortable: false,
      },
      override_actor_id: {
        type: 'string',
        label: { es: 'Autorizó', en: 'Overridden By' },
        input: 'select',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
      // Staff-only memo field. Writable in any state; once terminal it is the only editable field.
      staff_note: {
        type: 'string',
        label: { es: 'Nota de Staff', en: 'Staff Note' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Turno', en: 'Appointment' },
    title: { es: 'Turnos', en: 'Appointments' },
    protected: true,
    status: {
      column: 'state',
      values: APPOINTMENT_STATES.map((s) => ({ value: s.value, label: s.label })),
    },
  } satisfies TableStructure,

  // A professional sharing calendar access with another user. Managed through explicit
  // grant endpoints; not exposed through generic CRUD.
  calendar_grants: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'user_id', labelField: 'display_name' },
      },
      grantee_user_id: {
        type: 'string',
        label: { es: 'Usuario Autorizado', en: 'Grantee' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
    },
    pk: 'id',
    uiName: { es: 'Permiso de Calendario', en: 'Calendar Grant' },
    title: { es: 'Permisos de Calendario', en: 'Calendar Grants' },
    protected: true,
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
  } satisfies TableStructure,
};

// Availability is computed, not stored: weekly pattern minus dated exceptions minus booked.
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// 'HH:MM' 24h, end-exclusive. A weekly schedule block also carries its own
// granularity_minutes (per-block slot size); the free-window callers omit it.
export type TimeInterval = { start: string; end: string; granularity_minutes?: number };
export type WeeklySchedule = Partial<Record<Weekday, TimeInterval[]>>;

export type ScheduleExceptionInput = {
  is_unavailable: boolean;
  start_time?: string | null;
  end_time?: string | null;
  // Slot size for a changed-hours "available" exception; null for full-day/blocked (D-07c).
  granularity_minutes?: number | null;
};

type MinuteInterval = { start: number; end: number };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function mergeIntervals(intervals: MinuteInterval[]): MinuteInterval[] {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: MinuteInterval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function subtractIntervals(base: MinuteInterval[], blocks: MinuteInterval[]): MinuteInterval[] {
  const merged = mergeIntervals(blocks);
  let current = mergeIntervals(base);
  for (const block of merged) {
    const next: MinuteInterval[] = [];
    for (const iv of current) {
      if (block.end <= iv.start || block.start >= iv.end) {
        next.push(iv); // no overlap
        continue;
      }
      if (block.start > iv.start) next.push({ start: iv.start, end: block.start });
      if (block.end < iv.end) next.push({ start: block.end, end: iv.end });
    }
    current = next;
  }
  return current;
}

export function validateWeeklySchedule(
  value: unknown,
): { ok: true; value: WeeklySchedule } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['weekly schedule must be an object keyed by weekday'] };
  }
  const out: WeeklySchedule = {};
  for (const [day, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      errors.push(`'${day}' is not a valid weekday`);
      continue;
    }
    if (!Array.isArray(raw)) {
      errors.push(`${day} must be an array of { start, end } intervals`);
      continue;
    }
    const minutes: MinuteInterval[] = [];
    for (const iv of raw) {
      const start = (iv as TimeInterval)?.start;
      const end = (iv as TimeInterval)?.end;
      if (typeof start !== 'string' || !TIME_RE.test(start) || typeof end !== 'string' || !TIME_RE.test(end)) {
        errors.push(`${day} has an interval with an invalid HH:MM time`);
        continue;
      }
      if (toMinutes(end) <= toMinutes(start)) {
        errors.push(`${day} interval ${start}-${end} must have end after start`);
        continue;
      }
      const gran = (iv as TimeInterval)?.granularity_minutes;
      if (gran === undefined || gran === null) {
        errors.push(`${day} interval ${start}-${end} is missing granularity_minutes`);
      } else if (typeof gran !== 'number' || !Number.isInteger(gran) || gran <= 0) {
        errors.push(`${day} interval ${start}-${end} granularity_minutes must be a positive integer`);
      } else if ((toMinutes(end) - toMinutes(start)) % gran !== 0) {
        errors.push(
          `${day} interval ${start}-${end} length must be a whole multiple of its granularity_minutes`,
        );
      }
      minutes.push({ start: toMinutes(start), end: toMinutes(end) });
    }
    const sorted = [...minutes].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) {
        errors.push(`${day} has overlapping intervals`);
        break;
      }
    }
    // Persist a normalized projection (start/end/granularity only), never the raw input — so
    // unexpected extra keys on an interval object are not written through to the JSONB column.
    out[day as Weekday] = (raw as unknown[]).map((iv) => {
      const t = iv as Partial<TimeInterval> | null;
      return {
        start: t?.start as string,
        end: t?.end as string,
        granularity_minutes: t?.granularity_minutes,
      };
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// Weekly base for the weekday, widened by "available" exceptions then narrowed by
// "unavailable" ones. Booked appointments are NOT subtracted here. End-exclusive.
function availableMinuteIntervals(
  weekday: Weekday,
  weekly: WeeklySchedule,
  exceptions: ScheduleExceptionInput[],
): MinuteInterval[] {
  if (exceptions.some((e) => e.is_unavailable && !e.start_time && !e.end_time)) return [];

  let base = mergeIntervals(
    (weekly[weekday] ?? []).map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) })),
  );

  const additions: MinuteInterval[] = [];
  const blocks: MinuteInterval[] = [];
  for (const e of exceptions) {
    if (!e.start_time || !e.end_time) continue;
    const iv = { start: toMinutes(e.start_time), end: toMinutes(e.end_time) };
    if (iv.end <= iv.start) continue;
    (e.is_unavailable ? blocks : additions).push(iv);
  }

  base = mergeIntervals([...base, ...additions]);
  return subtractIntervals(base, blocks);
}

// Free intervals for one owner on one date: weekly base, widened by "available" exceptions,
// then narrowed by "unavailable" exceptions and booked appointments. End-exclusive throughout.
export function computeDailyAvailability(input: {
  date: string; // 'YYYY-MM-DD'
  weekly: WeeklySchedule;
  exceptions?: ScheduleExceptionInput[];
  booked?: TimeInterval[];
}): TimeInterval[] {
  const { date, weekly, exceptions = [], booked = [] } = input;
  const base = availableMinuteIntervals(weekdayOf(date), weekly, exceptions);
  const bookedMin = booked.map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) }));
  const free = subtractIntervals(base, bookedMin);
  return free.map((iv) => ({ start: toHHMM(iv.start), end: toHHMM(iv.end) }));
}

// Discrete bookable slots for one owner on one date: each weekly block chopped into
// back-to-back fixed slots of its granularity (measured from block start), kept only when
// the slot lies fully inside the available window (weekly ± exceptions) and overlaps no
// booked (scheduled+requested) interval. End-exclusive throughout.
export function computeDailySlots(input: {
  date: string; // 'YYYY-MM-DD'
  weekly: WeeklySchedule;
  exceptions?: ScheduleExceptionInput[];
  booked?: TimeInterval[];
}): TimeInterval[] {
  const { date, weekly, exceptions = [], booked = [] } = input;
  const weekday = weekdayOf(date);
  const available = availableMinuteIntervals(weekday, weekly, exceptions);
  if (available.length === 0) return [];

  const bookedMin = booked.map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) }));

  // Slots come from weekly blocks AND changed-hours "available" exceptions, each chopped at its
  // own granularity — so an exception opening hours outside the weekly pattern is bookable (D-07c).
  const sources: Array<{ start: number; end: number; gran: number }> = [];
  for (const block of weekly[weekday] ?? []) {
    const gran = block.granularity_minutes;
    if (typeof gran === 'number' && Number.isInteger(gran) && gran > 0) {
      sources.push({ start: toMinutes(block.start), end: toMinutes(block.end), gran });
    }
  }
  for (const e of exceptions) {
    if (e.is_unavailable || !e.start_time || !e.end_time) continue;
    const gran = e.granularity_minutes;
    if (typeof gran === 'number' && Number.isInteger(gran) && gran > 0) {
      sources.push({ start: toMinutes(e.start_time), end: toMinutes(e.end_time), gran });
    }
  }

  const seen = new Set<string>();
  const slots: MinuteInterval[] = [];
  for (const src of sources) {
    for (let s = src.start; s + src.gran <= src.end; s += src.gran) {
      const slot = { start: s, end: s + src.gran };
      const inside = available.some((iv) => iv.start <= slot.start && slot.end <= iv.end);
      if (!inside) continue;
      const clash = bookedMin.some((b) =>
        detectOverlap({ startsAt: slot.start, endsAt: slot.end }, { startsAt: b.start, endsAt: b.end }),
      );
      if (clash) continue;
      const key = `${slot.start}-${slot.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }
  }
  slots.sort((a, b) => a.start - b.start);
  return slots.map((iv) => ({ start: toHHMM(iv.start), end: toHHMM(iv.end) }));
}

export function detectOverlap(
  a: { startsAt: number; endsAt: number },
  b: { startsAt: number; endsAt: number },
): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}
