import { businessTables, AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES } from './business';
import { peopleTables, ROLE_OPTIONS, ROLE_LABELS, WRITE_PROTECTED_COLUMNS, PASSWORD_REUSE_KEY, isPasswordReused } from './people';
import { catalogTables } from './catalog';
import {
  CONSTRAINT_DETAIL_KEYS,
  USER_IDENTITY_CONSTRAINT_DETAIL_KEYS,
  INTENTIONALLY_GENERIC_CONSTRAINTS,
} from './constraint-messages';
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
  businessDate,
  WEEKDAYS,
  computeServiceSlots,
  computeFreeWindows,
  weekdayOf,
  isWeekday,
  detectOverlap,
  toMinutes,
  toHHMM,
  mergeIntervals,
  isValidTimeRange,
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
export { LEDGER_ENTRY_TYPES, LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES, LEDGER_WRITE_ROLES, RECEPTIONIST_APPOINTMENT_LINKED_TYPES } from './finance';
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
// auditEventLabel/WRITE_EVENT_SUFFIX are NOT re-exported here on purpose: audit-events.ts reads
// table descriptors back out of `structure` (via utils.ts), and structure.ts is assembled from
// this barrel — re-exporting it here would import audit-events.ts before `structure.tables` is
// populated, a circular init that leaves getTableKeys() looking at an undefined object. Import
// audit-events.ts directly instead.
export { ROLE_OPTIONS, ROLE_LABELS, WRITE_PROTECTED_COLUMNS, PASSWORD_REUSE_KEY, isPasswordReused };
export { CONSTRAINT_DETAIL_KEYS, USER_IDENTITY_CONSTRAINT_DETAIL_KEYS, INTENTIONALLY_GENERIC_CONSTRAINTS };
