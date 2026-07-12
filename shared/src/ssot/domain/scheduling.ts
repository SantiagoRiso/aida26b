import type { TableStructure } from '../../types/types';
import { pkColumn } from './business';

// States from which no further transition is permitted; price captured at booking is frozen here.
export const TERMINAL_STATES = new Set(['completed', 'canceled', 'no_show', 'rejected']);

export const TRANSITION_MAP: Record<string, readonly string[]> = {
  requested: ['scheduled', 'rejected', 'canceled'],
  scheduled: ['completed', 'canceled', 'no_show'],
};

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

// Still-actionable states: a pending or upcoming turno (not yet resolved). The one source for the
// "open" set — read as a function in app logic and as a SQL list in availability/conflict queries.
export const OPEN_APPOINTMENT_STATES = ['requested', 'scheduled'] as const;

export function isOpenAppointmentState(state: string): boolean {
  return (OPEN_APPOINTMENT_STATES as readonly string[]).includes(state);
}

// States that void a turno — never real service history. Excluded from the calendar and from
// relationship / billing-eligibility checks. The one source both sides read that pair from.
export const VOID_APPOINTMENT_STATES = ['canceled', 'rejected'] as const;

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
  // One working block for exactly one owner (professional XOR resource, DB-enforced). Several
  // blocks per owner/weekday express morning+afternoon. business_id is derived via the owner.
  // A professional edits own blocks; a granted receptionist edits granted ones; admin all.
  schedule_blocks: {
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
      weekday: {
        type: 'string',
        label: { es: 'Día', en: 'Weekday' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: [
          { value: 'mon', label: { es: 'Lunes', en: 'Monday' } },
          { value: 'tue', label: { es: 'Martes', en: 'Tuesday' } },
          { value: 'wed', label: { es: 'Miércoles', en: 'Wednesday' } },
          { value: 'thu', label: { es: 'Jueves', en: 'Thursday' } },
          { value: 'fri', label: { es: 'Viernes', en: 'Friday' } },
          { value: 'sat', label: { es: 'Sábado', en: 'Saturday' } },
          { value: 'sun', label: { es: 'Domingo', en: 'Sunday' } },
        ],
      },
      start_time: {
        type: 'string',
        label: { es: 'Hora Inicio', en: 'Start Time' },
        validator: { required: true, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', patternMessage: 'must be HH:MM' },
        filterable: false,
        sortable: true,
      },
      end_time: {
        type: 'string',
        label: { es: 'Hora Fin', en: 'End Time' },
        validator: { required: true, pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', patternMessage: 'must be HH:MM' },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Bloque de Horario', en: 'Schedule Block' },
    title: { es: 'Bloques de Horario', en: 'Schedule Blocks' },
    addButtonLabel: { es: 'Agregar Bloque', en: 'Add Block' },
    crud: { create: true, read: true, update: true, delete: true },
    businessJoin: {
      paths: [
        { parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' },
        { parentTable: 'resources',  localFk: 'resource_id',           parentPk: 'id' },
      ],
    },
    ownership: { ownerColumn: 'professional_user_id', role: 'Professional' },
    grantScope: {
      role: 'Receptionist',
      grantTable: 'calendar_grants',
      grantRowColumn: 'professional_user_id',
      granteeColumn: 'grantee_user_id',
    },
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin', 'Professional', 'Receptionist'],
    },
  } satisfies TableStructure,

  // Which services a professional block offers, with optional per-block duration/price overrides
  // (null → service default). Only professional blocks have these (resource blocks are bare
  // windows). professional_user_id is denormalized from the block so the row scopes exactly like
  // schedule_blocks (business via the owner, own-only, grant-aware); it must equal the block owner.
  schedule_block_services: {
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
        referencesUserRole: 'Professional',
      },
      schedule_block_id: {
        type: 'string',
        label: { es: 'Bloque', en: 'Block' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'schedule_blocks', valueField: 'id', labelField: 'id' },
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
      duration_minutes: {
        type: 'number',
        label: { es: 'Duración (min)', en: 'Duration (min)' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      price_ars: {
        type: 'string',
        label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
        validator: { nullable: true, pattern: '^\\d+(\\.\\d{1,2})?$', patternMessage: 'must be a non-negative amount' },
        filterable: false,
        sortable: true,
      },
    },
    pk: 'id',
    uiName: { es: 'Servicio del Bloque', en: 'Block Service' },
    title: { es: 'Servicios del Bloque', en: 'Block Services' },
    addButtonLabel: { es: 'Agregar Servicio', en: 'Add Service' },
    crud: { create: true, read: true, update: true, delete: true },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
    ownership: { ownerColumn: 'professional_user_id', role: 'Professional' },
    grantScope: {
      role: 'Receptionist',
      grantTable: 'calendar_grants',
      grantRowColumn: 'professional_user_id',
      granteeColumn: 'grantee_user_id',
    },
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin', 'Professional', 'Receptionist'],
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

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// 'HH:MM' 24h, end-exclusive. granularity_minutes is an optional per-interval slot size
// some callers carry; free-window callers omit it.
export type TimeInterval = { start: string; end: string; granularity_minutes?: number };

export type ScheduleExceptionInput = {
  is_unavailable: boolean;
  start_time?: string | null;
  end_time?: string | null;
  // Slot size for a changed-hours "available" exception; null for full-day/blocked.
  granularity_minutes?: number | null;
};

type MinuteInterval = { start: number; end: number };

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
        next.push(iv);
        continue;
      }
      if (block.start > iv.start) next.push({ start: iv.start, end: block.start });
      if (block.end < iv.end) next.push({ start: block.end, end: iv.end });
    }
    current = next;
  }
  return current;
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function detectOverlap(
  a: { startsAt: number; endsAt: number },
  b: { startsAt: number; endsAt: number },
): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

// A working block already resolved for one chosen service: slot_minutes is that service's
// effective duration inside this block (per-block override else the service default). The
// caller resolves slot_minutes; this function only tiles.
export type ServiceBlock = { start: string; end: string; slot_minutes: number };

// Service-driven slots for one owner on one date: each block chopped into back-to-back slots of
// its own slot_minutes (measured from block start), kept only when the slot lies fully inside the
// available window (blocks ± exceptions) and overlaps no booked interval. End-exclusive. The slot
// size comes from the chosen service, not a fixed per-block grid.
// Working windows for one date after exceptions: blocks ∪ extra-hours − blocked-hours, merged.
// Empty on a full-day off. The service-independent base the slot tiler and the free-window view
// both build on.
function availableMinuteWindows(
  blocks: { start: string; end: string }[],
  exceptions: ScheduleExceptionInput[],
): MinuteInterval[] {
  if (exceptions.some((e) => e.is_unavailable && !e.start_time && !e.end_time)) return [];
  const base = mergeIntervals(blocks.map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) })));
  const additions: MinuteInterval[] = [];
  const blockOffs: MinuteInterval[] = [];
  for (const e of exceptions) {
    if (!e.start_time || !e.end_time) continue;
    const iv = { start: toMinutes(e.start_time), end: toMinutes(e.end_time) };
    if (iv.end <= iv.start) continue;
    (e.is_unavailable ? blockOffs : additions).push(iv);
  }
  return subtractIntervals(mergeIntervals([...base, ...additions]), blockOffs);
}

// Service-independent free windows for one owner on one date: the working windows (blocks ±
// exceptions) with booked spans removed, as contiguous intervals — NOT tiled into service-sized
// slots. Feeds the staff calendar's availability shading and snap lattice, which have no chosen
// service (a professional's schedule is service-agnostic; slot sizing only matters for booking).
export function computeFreeWindows(input: {
  blocks: { start: string; end: string }[];
  exceptions?: ScheduleExceptionInput[];
  booked?: TimeInterval[];
}): TimeInterval[] {
  const { blocks, exceptions = [], booked = [] } = input;
  const available = availableMinuteWindows(blocks, exceptions);
  const bookedMin = booked.map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) }));
  return subtractIntervals(available, bookedMin).map((iv) => ({ start: toHHMM(iv.start), end: toHHMM(iv.end) }));
}

export function computeServiceSlots(input: {
  blocks: ServiceBlock[];
  exceptions?: ScheduleExceptionInput[];
  booked?: TimeInterval[];
}): TimeInterval[] {
  const { blocks, exceptions = [], booked = [] } = input;
  const available = availableMinuteWindows(blocks, exceptions);
  if (available.length === 0) return [];

  const bookedMin = booked.map((iv) => ({ start: toMinutes(iv.start), end: toMinutes(iv.end) }));
  const seen = new Set<string>();
  const slots: MinuteInterval[] = [];
  for (const b of blocks) {
    const gran = b.slot_minutes;
    if (!Number.isInteger(gran) || gran <= 0) continue;
    for (let s = toMinutes(b.start); s + gran <= toMinutes(b.end); s += gran) {
      const slot = { start: s, end: s + gran };
      if (!available.some((iv) => iv.start <= slot.start && slot.end <= iv.end)) continue;
      const clash = bookedMin.some((k) =>
        detectOverlap({ startsAt: slot.start, endsAt: slot.end }, { startsAt: k.start, endsAt: k.end }),
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
