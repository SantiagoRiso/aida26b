import { describe, it, expect } from 'vitest';
import { classifyException, exceptionToBgEvent, filterByRange, nextDay, buildExceptionBody, type ExceptionRow } from '@/composables/scheduleExceptions';

function row(overrides: Partial<ExceptionRow> = {}): ExceptionRow {
  return {
    id: '1',
    professional_user_id: '10',
    resource_id: null,
    exception_date: '2026-07-15',
    is_unavailable: true,
    start_time: null,
    end_time: null,
    granularity_minutes: null,
    reason: null,
    ...overrides,
  };
}

describe('classifyException', () => {
  it('classifies a full-day off row (unavailable, no times)', () => {
    expect(classifyException(row({ is_unavailable: true, start_time: null, end_time: null }))).toBe('off');
  });

  it('classifies a partial-unavailable window as block', () => {
    expect(classifyException(row({ is_unavailable: true, start_time: '09:00', end_time: '12:00' }))).toBe('block');
  });

  it('classifies an extra-hours (available) window as extra', () => {
    expect(classifyException(row({
      is_unavailable: false, start_time: '18:00', end_time: '20:00', granularity_minutes: 30,
    }))).toBe('extra');
  });
});

describe('exceptionToBgEvent', () => {
  it('renders a full-day off as a timed midnight-to-midnight span with the off class', () => {
    const r = row({ reason: 'Vacaciones' });
    const ev = exceptionToBgEvent(r);
    expect(ev.start).toBe('2026-07-15T00:00:00');
    expect(ev.end).toBe('2026-07-16T00:00:00');
    expect(ev.allDay).toBeUndefined();
    expect(ev.display).toBe('background');
    expect(ev.classNames).toEqual(['fc-exception-off']);
    expect(ev.title).toBe('Vacaciones');
    expect(ev.extendedProps).toEqual({ exception: r });
  });

  it('renders a partial-unavailable window with HH:MM boundaries and the block class', () => {
    const r = row({ is_unavailable: true, start_time: '09:00', end_time: '12:00', reason: 'Capacitación' });
    const ev = exceptionToBgEvent(r);
    expect(ev.start).toBe('2026-07-15T09:00:00');
    expect(ev.end).toBe('2026-07-15T12:00:00');
    expect(ev.classNames).toEqual(['fc-exception-block']);
    expect(ev.title).toBe('Capacitación');
  });

  it('renders an extra-hours window with the extra class', () => {
    const r = row({
      is_unavailable: false, start_time: '18:00', end_time: '20:00', granularity_minutes: 30, reason: null,
    });
    const ev = exceptionToBgEvent(r);
    expect(ev.start).toBe('2026-07-15T18:00:00');
    expect(ev.end).toBe('2026-07-15T20:00:00');
    expect(ev.classNames).toEqual(['fc-exception-extra']);
  });

  it('builds valid boundaries from an API time serialised as HH:MM:SS', () => {
    const r = row({ is_unavailable: true, start_time: '09:00:00', end_time: '12:30:00' });
    const ev = exceptionToBgEvent(r);
    expect(ev.start).toBe('2026-07-15T09:00:00');
    expect(ev.end).toBe('2026-07-15T12:30:00');
  });
});

describe('nextDay', () => {
  it('advances one calendar day', () => {
    expect(nextDay('2026-07-11')).toBe('2026-07-12');
  });

  it('rolls over a month boundary', () => {
    expect(nextDay('2026-07-31')).toBe('2026-08-01');
  });
});

describe('filterByRange', () => {
  it('keeps only rows whose exception_date falls in [from, to)', () => {
    const rows = [
      row({ id: '1', exception_date: '2026-07-10' }),
      row({ id: '2', exception_date: '2026-07-15' }),
      row({ id: '3', exception_date: '2026-07-17' }),
      row({ id: '4', exception_date: '2026-07-20' }),
    ];
    const result = filterByRange(rows, '2026-07-12', '2026-07-20');
    expect(result.map((r) => r.id)).toEqual(['2', '3']);
  });

  it('returns an empty array when nothing is in range', () => {
    const rows = [row({ exception_date: '2026-01-01' })];
    expect(filterByRange(rows, '2026-07-01', '2026-08-01')).toEqual([]);
  });
});

describe('buildExceptionBody', () => {
  const profOwner = { professional_user_id: 10, resource_id: null };

  it('builds a full-day off body: both times null, granularity null', () => {
    const result = buildExceptionBody({ kind: 'off', owner: profOwner, date: '2026-07-15', reason: 'Vacaciones' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      professional_user_id: '10',
      resource_id: null,
      exception_date: '2026-07-15',
      is_unavailable: true,
      start_time: null,
      end_time: null,
      granularity_minutes: null,
      reason: 'Vacaciones',
    });
  });

  it('builds a partial-unavailable body: times set, granularity null', () => {
    const result = buildExceptionBody({
      kind: 'block', owner: profOwner, date: '2026-07-15', start_time: '09:00', end_time: '12:00',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      is_unavailable: true,
      start_time: '09:00',
      end_time: '12:00',
      granularity_minutes: null,
    });
  });

  it('builds an extra-hours body: is_unavailable false, times set, granularity > 0', () => {
    const result = buildExceptionBody({
      kind: 'extra', owner: profOwner, date: '2026-07-15', start_time: '18:00', end_time: '20:00', granularity_minutes: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      is_unavailable: false,
      start_time: '18:00',
      end_time: '20:00',
      granularity_minutes: 30,
    });
  });

  it('rejects a partial-unavailable window with start >= end', () => {
    const result = buildExceptionBody({ kind: 'block', owner: profOwner, date: '2026-07-15', start_time: '12:00', end_time: '12:00' });
    expect(result.ok).toBe(false);
  });

  it('rejects an extra-hours window with start >= end', () => {
    const result = buildExceptionBody({
      kind: 'extra', owner: profOwner, date: '2026-07-15', start_time: '20:00', end_time: '18:00', granularity_minutes: 30,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an extra-hours body with missing granularity', () => {
    const result = buildExceptionBody({ kind: 'extra', owner: profOwner, date: '2026-07-15', start_time: '18:00', end_time: '20:00' });
    expect(result.ok).toBe(false);
  });

  it('rejects an extra-hours body with zero granularity', () => {
    const result = buildExceptionBody({
      kind: 'extra', owner: profOwner, date: '2026-07-15', start_time: '18:00', end_time: '20:00', granularity_minutes: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an extra-hours body with a non-integer granularity', () => {
    const result = buildExceptionBody({
      kind: 'extra', owner: profOwner, date: '2026-07-15', start_time: '18:00', end_time: '20:00', granularity_minutes: 1.5,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a body with no owner set', () => {
    const result = buildExceptionBody({
      kind: 'off', owner: { professional_user_id: null, resource_id: null }, date: '2026-07-15',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a body with both owners set', () => {
    const result = buildExceptionBody({
      kind: 'off', owner: { professional_user_id: 10, resource_id: 5 }, date: '2026-07-15',
    });
    expect(result.ok).toBe(false);
  });

  it('builds a resource-owned body with resource_id set and professional_user_id null', () => {
    const result = buildExceptionBody({ kind: 'off', owner: { professional_user_id: null, resource_id: 3 }, date: '2026-07-15' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.professional_user_id).toBeNull();
    expect(result.body.resource_id).toBe('3');
  });
});
