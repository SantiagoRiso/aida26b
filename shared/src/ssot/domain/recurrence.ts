import type { LocalizedText, TableStructure } from '../../types/types';
import { pkColumn } from './business';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE } from './catalog';
import { HHMM_PATTERN, HHMM_PATTERN_MESSAGE, WEEKDAY_OPTIONS, isWeekday, type Weekday } from './availability';

export const FREQUENCY_VALUES = ['weekly', 'monthly_dow', 'monthly_dom'] as const;
export const END_KIND_VALUES = ['count', 'until', 'open'] as const;
export const SERIES_STATUS_VALUES = ['active', 'ended'] as const;

export type Frequency = (typeof FREQUENCY_VALUES)[number];
export type EndKind = (typeof END_KIND_VALUES)[number];
export type SeriesStatus = (typeof SERIES_STATUS_VALUES)[number];
export const ACTIVE_SERIES_STATUS: SeriesStatus = 'active';
export const ENDED_SERIES_STATUS: SeriesStatus = 'ended';
export const UNTIL_END_KIND: EndKind = 'until';
const RECURRENCE_LIMITS = {
  intervalMin: 1,
  weekOfMonthMin: 1,
  weekOfMonthMax: 5,
  dayOfMonthMin: 1,
  dayOfMonthMax: 31,
  endCountMin: 1,
} as const;

export const FREQUENCY_OPTIONS: Array<{ value: Frequency; label: LocalizedText }> = [
  { value: 'weekly', label: { es: 'Semanal', en: 'Weekly' } },
  { value: 'monthly_dow', label: { es: 'Mensual (día de la semana)', en: 'Monthly (day of week)' } },
  { value: 'monthly_dom', label: { es: 'Mensual (día del mes)', en: 'Monthly (day of month)' } },
];

export const END_KIND_OPTIONS: Array<{ value: EndKind; label: LocalizedText }> = [
  { value: 'count', label: { es: 'Por cantidad de repeticiones', en: 'By occurrence count' } },
  { value: 'until', label: { es: 'Hasta una fecha', en: 'Until a date' } },
  { value: 'open', label: { es: 'Sin fecha de fin', en: 'No end date' } },
];

// eslint-disable-next-line no-restricted-syntax -- Runtime guard validates an untrusted recurrence request field.
export function isFrequency(value: unknown): value is Frequency {
  return typeof value === 'string' && FREQUENCY_VALUES.some((candidate) => candidate === value);
}

// eslint-disable-next-line no-restricted-syntax -- Runtime guard validates an untrusted recurrence request field.
export function isEndKind(value: unknown): value is EndKind {
  return typeof value === 'string' && END_KIND_VALUES.some((candidate) => candidate === value);
}

export interface RecurrenceRuleFields {
  frequency: string;
  interval: number;
  weekday: string | null;
  week_of_month: number | null;
  day_of_month: number | null;
  start_time: string;
  start_date: string;
  end_kind: string;
  end_count: number | null;
  end_date: string | null;
}

export type ValidatedRecurrenceRuleFields = Omit<RecurrenceRuleFields, 'frequency' | 'weekday' | 'end_kind'> & {
  frequency: Frequency;
  weekday: Weekday | null;
  end_kind: EndKind;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = new RegExp(HHMM_PATTERN);

function isIntegerInRange(value: number | null, min: number, max?: number): value is number {
  return value !== null && Number.isInteger(value) && value >= min && (max === undefined || value <= max);
}

export function validateRecurrenceRule(rule: RecurrenceRuleFields): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!isFrequency(rule.frequency)) fields.frequency = `must be one of: ${FREQUENCY_VALUES.join(', ')}`;
  if (!isIntegerInRange(rule.interval, RECURRENCE_LIMITS.intervalMin)) fields.interval = 'must be a positive integer';
  if (!ISO_DATE_RE.test(rule.start_date)) fields.start_date = 'must be YYYY-MM-DD';
  if (!HHMM_RE.test(rule.start_time)) fields.start_time = 'must be HH:MM';

  const validWeekday = isWeekday(rule.weekday);
  if (rule.frequency === 'weekly') {
    if (!validWeekday) fields.weekday = 'required for weekly frequency';
    if (rule.week_of_month !== null) fields.week_of_month = 'must be omitted for weekly frequency';
    if (rule.day_of_month !== null) fields.day_of_month = 'must be omitted for weekly frequency';
  } else if (rule.frequency === 'monthly_dow') {
    if (!validWeekday) fields.weekday = 'required for monthly_dow frequency';
    if (!isIntegerInRange(rule.week_of_month, RECURRENCE_LIMITS.weekOfMonthMin, RECURRENCE_LIMITS.weekOfMonthMax)) {
      fields.week_of_month = 'must be an integer 1..5';
    }
    if (rule.day_of_month !== null) fields.day_of_month = 'must be omitted for monthly_dow frequency';
  } else if (rule.frequency === 'monthly_dom') {
    if (rule.weekday !== null) fields.weekday = 'must be omitted for monthly_dom frequency';
    if (rule.week_of_month !== null) fields.week_of_month = 'must be omitted for monthly_dom frequency';
    if (!isIntegerInRange(rule.day_of_month, RECURRENCE_LIMITS.dayOfMonthMin, RECURRENCE_LIMITS.dayOfMonthMax)) {
      fields.day_of_month = 'must be an integer 1..31';
    }
  }

  if (!isEndKind(rule.end_kind)) {
    fields.end_kind = `must be one of: ${END_KIND_VALUES.join(', ')}`;
  } else if (rule.end_kind === 'count') {
    if (!isIntegerInRange(rule.end_count, RECURRENCE_LIMITS.endCountMin)) fields.end_count = 'required, must be a positive integer';
    if (rule.end_date !== null) fields.end_date = 'must be omitted for end_kind=count';
  } else if (rule.end_kind === 'until') {
    if (rule.end_date === null || !ISO_DATE_RE.test(rule.end_date)) fields.end_date = 'required, must be YYYY-MM-DD';
    else if (rule.end_date < rule.start_date) fields.end_date = 'must be on/after start_date';
    if (rule.end_count !== null) fields.end_count = 'must be omitted for end_kind=until';
  } else {
    if (rule.end_count !== null) fields.end_count = 'must be omitted for end_kind=open';
    if (rule.end_date !== null) fields.end_date = 'must be omitted for end_kind=open';
  }
  return fields;
}

export function parseRecurrenceRule(rule: RecurrenceRuleFields):
  | { data: ValidatedRecurrenceRuleFields }
  | { fields: Record<string, string> } {
  const fields = validateRecurrenceRule(rule);
  if (Object.keys(fields).length > 0) return { fields };
  if (!isFrequency(rule.frequency) || !isEndKind(rule.end_kind)) {
    return { fields: { recurrence: 'invalid recurrence rule' } };
  }
  return {
    data: {
      ...rule,
      frequency: rule.frequency,
      weekday: isWeekday(rule.weekday) ? rule.weekday : null,
      end_kind: rule.end_kind,
    },
  };
}

export interface ScheduleSeriesBody {
  client_user_id: number;
  professional_user_id: number;
  service_id: number;
  resource_id?: number | null;
  frequency: Frequency;
  interval: number;
  weekday?: Weekday | null;
  week_of_month?: number | null;
  day_of_month?: number | null;
  start_time: string;
  start_date: string;
  duration_minutes: number;
  end_kind: EndKind;
  end_count?: number | null;
  end_date?: string | null;
}

const SERIES_STATUS_LABELS: Record<SeriesStatus, LocalizedText> = {
  active: { es: 'Activa', en: 'Active' },
  ended: { es: 'Finalizada', en: 'Ended' },
};

export const recurrenceTables = {
  // The recurrence rule; occurrences are computed (never stored) until touched, then materialize
  // as an ordinary appointments row. No business_id column — business is derived via the owning
  // professional, exactly as appointments already does.
  appointment_series: {
    columns: {
      id: pkColumn,
      client_user_id: {
        type: 'string',
        label: { es: 'Cliente', en: 'Client' },
        editable: false,
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'clients', valueField: 'id', labelField: 'display_name' },
      },
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        editable: false,
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
      },
      service_id: {
        type: 'string',
        label: { es: 'Servicio', en: 'Service' },
        editable: false,
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
      },
      resource_id: {
        type: 'string',
        label: { es: 'Sala', en: 'Room' },
        editable: false,
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      frequency: {
        type: 'string',
        label: { es: 'Frecuencia', en: 'Frequency' },
        validator: { required: true },
        filterable: true,
        sortable: true,
        input: 'select',
        options: FREQUENCY_OPTIONS,
      },
      interval: {
        type: 'number',
        label: { es: 'Intervalo', en: 'Interval' },
        input: 'number',
        validator: { required: true, integer: true, minValue: RECURRENCE_LIMITS.intervalMin },
        filterable: false,
        sortable: false,
      },
      // Required for weekly/monthly_dow, NULL for monthly_dom (DB CHECK enforces the pattern shape).
      weekday: {
        type: 'string',
        label: { es: 'Día', en: 'Weekday' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: true,
        options: WEEKDAY_OPTIONS,
      },
      week_of_month: {
        type: 'number',
        label: { es: 'Semana del mes', en: 'Week of month' },
        input: 'number',
        validator: {
          nullable: true,
          integer: true,
          minValue: RECURRENCE_LIMITS.weekOfMonthMin,
          maxValue: RECURRENCE_LIMITS.weekOfMonthMax,
        },
        filterable: false,
        sortable: false,
      },
      day_of_month: {
        type: 'number',
        label: { es: 'Día del mes', en: 'Day of month' },
        input: 'number',
        validator: {
          nullable: true,
          integer: true,
          minValue: RECURRENCE_LIMITS.dayOfMonthMin,
          maxValue: RECURRENCE_LIMITS.dayOfMonthMax,
        },
        filterable: false,
        sortable: false,
      },
      start_time: {
        type: 'string',
        label: { es: 'Hora inicio', en: 'Start Time' },
        validator: { required: true, pattern: HHMM_PATTERN, patternMessage: HHMM_PATTERN_MESSAGE },
        filterable: false,
        sortable: true,
      },
      // Snapshot at creation — every occurrence, virtual or materialized, inherits it.
      duration_minutes: {
        type: 'number',
        label: { es: 'Duración (min)', en: 'Duration (min)' },
        input: 'number',
        validator: { required: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      // Frozen at creation — a price change is a deliberate this-and-future/whole-series edit.
      price_ars: {
        type: 'string',
        label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
        validator: {
          required: true,
          pattern: AMOUNT_PATTERN,
          patternMessage: AMOUNT_PATTERN_MESSAGE,
        },
        filterable: false,
        sortable: true,
      },
      start_date: {
        type: 'string',
        label: { es: 'Fecha inicio', en: 'Start Date' },
        input: 'date',
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      end_kind: {
        type: 'string',
        label: { es: 'Finalización', en: 'Ends' },
        validator: { required: true },
        filterable: true,
        sortable: false,
        input: 'select',
        options: END_KIND_OPTIONS,
      },
      // Required only when end_kind='count' (DB CHECK enforces the end-shape).
      end_count: {
        type: 'number',
        label: { es: 'Cantidad de repeticiones', en: 'Occurrence Count' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: RECURRENCE_LIMITS.endCountMin },
        filterable: false,
        sortable: false,
      },
      // Required only when end_kind='until' (DB CHECK enforces the end-shape).
      end_date: {
        type: 'string',
        label: { es: 'Fecha fin', en: 'End Date' },
        input: 'date',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      created_by_user_id: {
        type: 'string',
        label: { es: 'Creado por', en: 'Created By' },
        editable: false,
        validator: { nullable: true },
        filterable: false,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
      status: {
        type: 'string',
        label: { es: 'Estado', en: 'Status' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: SERIES_STATUS_VALUES.map((v) => ({ value: v, label: SERIES_STATUS_LABELS[v] })),
      },
    },
    pk: 'id',
    uiName: { es: 'Serie de turnos', en: 'Appointment Series' },
    title: { es: 'Series de turnos', en: 'Appointment Series' },
    protected: true,
    status: {
      column: 'status',
      values: SERIES_STATUS_VALUES.map((v) => ({ value: v, label: SERIES_STATUS_LABELS[v] })),
    },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
    // No crud/roleRequired/ownership/grantScope: series authorization is bespoke
    // (assertAppointmentActionAllowed — Admin, own Professional, granted Receptionist), not
    // generic-CRUD-driven. Declaring inert metadata here would misstate who the backend permits.
  } satisfies TableStructure,
};
