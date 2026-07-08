import { businessTables } from './business';
import { peopleTables } from './people';
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
export { LEDGER_ENTRY_TYPES } from './finance';
export type { LedgerEntryType } from './finance';
