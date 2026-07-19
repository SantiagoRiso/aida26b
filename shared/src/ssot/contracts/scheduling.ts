import type { TimeInterval } from '../domain/availability';
import type { ConflictVerdict } from '../domain/conflict';

export type ConflictCheckResult = ConflictVerdict & {
  effective_price: string;
  effective_duration_minutes: number;
};

export type AvailabilityResult = {
  date: string;
  slots: TimeInterval[];
  open: boolean;
  outside_window?: boolean;
};

export type BookingWindowResult = { min_date: string; max_date: string | null };
export type TimeOffConflictCountResult = { count: number };
