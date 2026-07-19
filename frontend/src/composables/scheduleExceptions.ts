import type { EventInput } from '@fullcalendar/core';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import { tableRecord } from '@/api/ssot-decoder';

export type ExceptionKind = 'off' | 'block' | 'extra';

export type ExceptionRow = Wire<TableRecordMap['schedule_exceptions']>;
export const exceptionContract = tableRecord('schedule_exceptions');

// Full-day off has no time window; a partial window is either blocked (is_unavailable) or an
// extra-hours opening — the DB CHECK guarantees these three shapes are exhaustive.
export function classifyException(row: ExceptionRow): ExceptionKind {
  if (row.is_unavailable && !row.start_time) return 'off';
  return row.is_unavailable ? 'block' : 'extra';
}

const KIND_CLASS: Record<ExceptionKind, string> = {
  off: 'fc-exception-off',
  block: 'fc-exception-block',
  extra: 'fc-exception-extra',
};

function pad(n: number): string { return String(n).padStart(2, '0'); }

// UTC arithmetic only — avoids local-timezone Date parsing shifting the date.
export function nextDay(dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function exceptionToBgEvent(row: ExceptionRow): EventInput {
  const kind = classifyException(row);
  const title = row.reason ?? '';
  const base: EventInput = {
    display: 'background',
    classNames: [KIND_CLASS[kind]],
    title,
    extendedProps: { exception: row },
  };
  if (kind === 'off') {
    // allDay events don't render in timeGridWeek/Day (allDaySlot:false), so shade the
    // whole day as a timed span instead — matches CalendarView's pastBgEvents approach.
    return {
      ...base,
      start: `${row.exception_date}T00:00:00`,
      end: `${nextDay(row.exception_date)}T00:00:00`,
    };
  }
  // The API serialises TIME as 'HH:MM:SS'; take HH:MM so a seconds-bearing value doesn't build
  // the malformed 'HH:MM:SS:00' datetime FullCalendar silently drops.
  const hhmm = (t: string | null) => (t ?? '').slice(0, 5);
  return {
    ...base,
    start: `${row.exception_date}T${hhmm(row.start_time)}:00`,
    end: `${row.exception_date}T${hhmm(row.end_time)}:00`,
  };
}

export function filterByRange(rows: ExceptionRow[], fromISO: string, toISO: string): ExceptionRow[] {
  return rows.filter((r) => r.exception_date >= fromISO && r.exception_date < toISO);
}

export interface ExceptionOwner {
  professional_user_id?: number | null;
  resource_id?: number | null;
}

export interface BuildExceptionBodyInput {
  kind: ExceptionKind;
  owner: ExceptionOwner;
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  granularity_minutes?: number | null;
  reason?: string | null;
}

export type ExceptionBody = Partial<TableRecordMap['schedule_exceptions']>;

export type BuildExceptionBodyResult =
  | { ok: true; body: ExceptionBody }
  | { ok: false; reason: 'owner' | 'range' | 'granularity' };

// Enforces the schedule_exceptions DB CHECK: exactly one owner, full-day has no time window,
// block/extra need end > start, and only extra carries a positive granularity.
export function buildExceptionBody(input: BuildExceptionBodyInput): BuildExceptionBodyResult {
  const professionalId = input.owner.professional_user_id ?? null;
  const resourceId = input.owner.resource_id ?? null;
  if ((professionalId == null) === (resourceId == null)) return { ok: false, reason: 'owner' };

  const timed = input.kind !== 'off';
  if (timed && (!input.start_time || !input.end_time || input.start_time >= input.end_time)) {
    return { ok: false, reason: 'range' };
  }
  if (
    input.kind === 'extra' &&
    (!input.granularity_minutes || input.granularity_minutes <= 0 || !Number.isInteger(input.granularity_minutes))
  ) {
    return { ok: false, reason: 'granularity' };
  }

  return {
    ok: true,
    body: {
      professional_user_id: professionalId != null ? String(professionalId) : null,
      resource_id: resourceId != null ? String(resourceId) : null,
      exception_date: input.date,
      is_unavailable: input.kind !== 'extra',
      start_time: timed ? input.start_time ?? null : null,
      end_time: timed ? input.end_time ?? null : null,
      granularity_minutes: input.kind === 'extra' ? input.granularity_minutes ?? null : null,
      reason: input.reason ?? null,
    },
  };
}
