import { businessTables, AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES } from './business';
import { peopleTables, ROLE_OPTIONS, ROLE_LABELS } from './people';
import { catalogTables } from './catalog';
import { schedulingTables } from './scheduling';
import { financeTables } from './finance';

// Key order matches the migration's dependency order.
export const schedulerTables = {
  ...businessTables,
  ...peopleTables,
  ...catalogTables,
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
export { LEDGER_ENTRY_TYPES, LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES, LEDGER_WRITE_ROLES } from './finance';
export type { LedgerEntryType } from './finance';
export { AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES };
export type { AuditOutcome } from './business';
export { ROLE_OPTIONS, ROLE_LABELS };
