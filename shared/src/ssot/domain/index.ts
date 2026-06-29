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
  detectOverlap,
} from './scheduling';
export type { Weekday, TimeInterval, WeeklySchedule, ScheduleExceptionInput } from './scheduling';
