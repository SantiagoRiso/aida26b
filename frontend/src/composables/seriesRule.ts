// Shared recurrence-rule shape logic — used by AppointmentForm's create-time "Repetir" fields and
// by the series rule editor (whole-series / this-and-future edits). One place for the
// frequency-dependent field visibility and validation, mirroring validateSeriesRuleShape on the
// backend (and the DB's appointment_series_pattern_shape / _end_shape CHECKs).
import { weekdayOf } from '@shared/ssot/domain/availability';
import type { Frequency, EndKind } from '@shared/ssot/domain/recurrence';
import { validateRecurrenceRule, type RecurrenceRuleFields } from '@shared/ssot/domain/recurrence';
import type { AppointmentSeries, ScheduleSeriesBody } from '@/api/appointments';

export interface RecurrenceState {
  frequency: Frequency;
  interval: string;
  weekday: string;
  week_of_month: string;
  day_of_month: string;
  end_kind: EndKind;
  end_count: string;
  end_date: string;
}

export function defaultRecurrenceState(): RecurrenceState {
  return {
    frequency: 'weekly',
    interval: '1',
    weekday: '',
    week_of_month: '1',
    day_of_month: '1',
    end_kind: 'count',
    end_count: '1',
    end_date: '',
  };
}

// Prefills the editor from a fetched series row — numeric columns arrive as numbers/strings on the
// wire, the form fields are all strings (same convention AppointmentForm already uses).
export function recurrenceStateFromSeries(series: AppointmentSeries): RecurrenceState {
  return {
    frequency: series.frequency,
    interval: String(series.interval),
    weekday: series.weekday ?? '',
    week_of_month: series.week_of_month != null ? String(series.week_of_month) : '1',
    day_of_month: series.day_of_month != null ? String(series.day_of_month) : '1',
    end_kind: series.end_kind,
    end_count: series.end_count != null ? String(series.end_count) : '1',
    end_date: series.end_date ?? '',
  };
}

export function recurrenceShape(recurrence: Pick<RecurrenceState, 'frequency'>): {
  showsWeekday: boolean;
  showsWeekOfMonth: boolean;
  showsDayOfMonth: boolean;
} {
  return {
    showsWeekday: recurrence.frequency === 'weekly' || recurrence.frequency === 'monthly_dow',
    showsWeekOfMonth: recurrence.frequency === 'monthly_dow',
    showsDayOfMonth: recurrence.frequency === 'monthly_dom',
  };
}

// Minimal client-side check (required fields per frequency/end_kind, interval >= 1); the server
// re-validates authoritatively — this only avoids a round-trip for obviously incomplete input.
export function validateRecurrenceFields(recurrence: RecurrenceState, t: (key: string) => string): Record<string, string> {
  const numberOrNull = (value: string): number | null => value === '' ? null : Number(value);
  const shape = recurrenceShape(recurrence);
  const rule: RecurrenceRuleFields = {
    frequency: recurrence.frequency,
    interval: Number(recurrence.interval),
    weekday: shape.showsWeekday ? (recurrence.weekday || null) : null,
    week_of_month: shape.showsWeekOfMonth ? numberOrNull(recurrence.week_of_month) : null,
    day_of_month: shape.showsDayOfMonth ? numberOrNull(recurrence.day_of_month) : null,
    start_time: '00:00',
    start_date: '2000-01-01',
    end_kind: recurrence.end_kind,
    end_count: recurrence.end_kind === 'count' ? numberOrNull(recurrence.end_count) : null,
    end_date: recurrence.end_kind === 'until' ? (recurrence.end_date || null) : null,
  };
  const domainErrors = validateRecurrenceRule(rule);
  delete domainErrors.start_time;
  delete domainErrors.start_date;
  return Object.fromEntries(Object.keys(domainErrors).map((field) => [field, t('generic.required')]));
}

// Whole/this-and-future rule edit patch: unlike creation (where an omitted key simply means "not
// provided, default null"), the PUT/future routes treat an omitted key as "leave the stored value
// unchanged" — so a field that no longer applies under the new frequency must be sent as an
// explicit null, not left out, or the server keeps the old value and 422s the shape check.
export function buildRulePatch(recurrence: RecurrenceState): Partial<ScheduleSeriesBody> {
  const { showsWeekday, showsWeekOfMonth, showsDayOfMonth } = recurrenceShape(recurrence);
  return {
    frequency: recurrence.frequency,
    interval: Number(recurrence.interval),
    weekday: showsWeekday ? recurrence.weekday : null,
    week_of_month: showsWeekOfMonth ? Number(recurrence.week_of_month) : null,
    day_of_month: showsDayOfMonth ? Number(recurrence.day_of_month) : null,
    end_kind: recurrence.end_kind,
    end_count: recurrence.end_kind === 'count' ? Number(recurrence.end_count) : null,
    end_date: recurrence.end_kind === 'until' ? recurrence.end_date : null,
  };
}

// Reschedule-with-scope patch (Part 1): only the time itself moves — weekday is only meaningful
// (and only sent) when the series' own frequency is weekday-anchored; a monthly_dom series keeps
// its day_of_month untouched by a plain time change.
export function buildReschedulePatch(series: AppointmentSeries, date: string, start: string): Partial<ScheduleSeriesBody> {
  const patch: Partial<ScheduleSeriesBody> = { start_time: start };
  if (series.frequency === 'weekly' || series.frequency === 'monthly_dow') {
    patch.weekday = weekdayOf(date);
  }
  return patch;
}
