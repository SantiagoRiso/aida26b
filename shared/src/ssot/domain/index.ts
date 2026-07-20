import { businessTables, AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES } from './business';
import { peopleTables, ROLE_OPTIONS, ROLE_LABELS } from './people';
import { catalogTables } from './catalog';
import { recurrenceTables } from './recurrence';
import { schedulingTables } from './scheduling';
import { financeTables } from './finance';

// Key order matches the migration's dependency order. appointment_series depends only on
// auth.users/services/resources (all defined earlier) and is itself referenced by
// appointments.series_id, so it precedes schedulingTables.
export const schedulerTables = {
  ...businessTables,
  ...peopleTables,
  ...catalogTables,
  ...recurrenceTables,
  ...schedulingTables,
  ...financeTables,
};

export {
  BUSINESS_TZ,
  ARGENTINA_OFFSET_MS,
  WEEKDAYS,
  computeServiceSlots,
  computeFreeWindows,
  weekdayOf,
  isWeekday,
  detectOverlap,
  toMinutes,
  toHHMM,
  mergeIntervals,
} from './availability';
export type { Weekday, TimeInterval, ServiceBlock, ScheduleExceptionInput } from './availability';
export {
  TERMINAL_STATES,
  TRANSITION_MAP,
  APPOINTMENT_STATES,
  APPOINTMENT_STATE_VALUES,
  assertValidTransition,
  isOpenAppointmentState,
  OPEN_APPOINTMENT_STATES,
  VOID_APPOINTMENT_STATES,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
  canCancelAppointment,
  canMarkNoShow,
  canCompleteAppointment,
} from './appointment-lifecycle';
export type { AppointmentState, VoidAppointmentState } from './appointment-lifecycle';
export { resolveBooking } from './booking';
export { evaluateConflicts } from './conflict';
export type {
  OwnerKind,
  ConflictType,
  Conflict,
  ConflictVerdict,
  ConflictOwner,
  BookedAppointment,
} from './conflict';
export { LEDGER_ENTRY_TYPES, LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES, LEDGER_WRITE_ROLES, RECEPTIONIST_ENTRY_TYPES } from './finance';
export type { LedgerEntryType } from './finance';
export {
  FREQUENCY_VALUES,
  END_KIND_VALUES,
  SERIES_STATUS_VALUES,
  ACTIVE_SERIES_STATUS,
  ENDED_SERIES_STATUS,
  UNTIL_END_KIND,
  FREQUENCY_OPTIONS,
  END_KIND_OPTIONS,
  isFrequency,
  isEndKind,
  validateRecurrenceRule,
  validateRecurrenceRuleIssues,
  parseRecurrenceRule,
} from './recurrence';
export type {
  Frequency,
  EndKind,
  SeriesStatus,
  ScheduleSeriesBody,
  RecurrenceRuleFields,
  ValidatedRecurrenceRuleFields,
} from './recurrence';
export { expandSeries, seriesRuleFromRow } from './recurrence-expand';
export type { SeriesRule } from './recurrence-expand';
export { seriesOccupancyForDate } from './recurrence-occupancy';
export { AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES };
export type { AuditOutcome } from './business';
export { ROLE_OPTIONS, ROLE_LABELS };
