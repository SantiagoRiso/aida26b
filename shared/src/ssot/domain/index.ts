import { businessTables, AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES } from './business';
import { peopleTables, ROLE_OPTIONS } from './people';
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
  WEEKDAYS,
  validateWeeklySchedule,
  computeDailyAvailability,
  computeDailySlots,
  detectOverlap,
  TERMINAL_STATES,
  TRANSITION_MAP,
  APPOINTMENT_STATE_VALUES,
  assertValidTransition,
  isOpenAppointmentState,
  OPEN_APPOINTMENT_STATES,
  VOID_APPOINTMENT_STATES,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
  canCancelAppointment,
} from './scheduling';
export type { Weekday, TimeInterval, WeeklySchedule, ScheduleExceptionInput } from './scheduling';
export { resolveBooking } from './catalog';
export { evaluateConflicts } from './conflict';
export type {
  ConflictType,
  Conflict,
  ConflictVerdict,
  ConflictOwner,
  BookedAppointment,
} from './conflict';
export { LEDGER_ENTRY_TYPES, LEDGER_DEBIT_TYPES, LEDGER_CREDIT_TYPES } from './finance';
export type { LedgerEntryType } from './finance';
export { AUDIT_OUTCOME_VALUES, AUDIT_OUTCOMES };
export { ROLE_OPTIONS };
