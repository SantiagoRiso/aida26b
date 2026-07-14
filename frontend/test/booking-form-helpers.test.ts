import { describe, it, expect } from 'vitest';
import { isoDate, addDaysISO, intervalMinutes, offeredServiceIds } from '@/composables/bookingForm';

describe('bookingForm helpers', () => {
  it('isoDate formats a local Date as YYYY-MM-DD', () => {
    // month is 0-based: 6 = July
    expect(isoDate(new Date(2026, 6, 5))).toBe('2026-07-05');
  });

  it('addDaysISO steps by whole days, handling month/year rollover', () => {
    expect(addDaysISO('2026-07-05', 1)).toBe('2026-07-06');
    expect(addDaysISO('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-07-05', 0)).toBe('2026-07-05');
  });

  it('intervalMinutes returns the minutes between two HH:mm times', () => {
    expect(intervalMinutes('09:00', '09:30')).toBe(30);
    expect(intervalMinutes('09:15', '10:45')).toBe(90);
    expect(intervalMinutes('09:00', '09:00')).toBe(0);
  });

  it('offeredServiceIds returns null (no restriction) when no professional is given', () => {
    expect(offeredServiceIds([{ professional_user_id: '7', service_id: '1' }], null)).toBeNull();
  });

  it('offeredServiceIds returns null when the professional has no offerings', () => {
    expect(offeredServiceIds([{ professional_user_id: '7', service_id: '1' }], '9')).toBeNull();
  });

  it('offeredServiceIds returns the set of service ids the professional offers', () => {
    const rows = [
      { professional_user_id: '7', service_id: '1' },
      { professional_user_id: '7', service_id: '2' },
      { professional_user_id: '9', service_id: '3' },
    ];
    const set = offeredServiceIds(rows, '7');
    expect(set).not.toBeNull();
    expect([...set!].sort()).toEqual(['1', '2']);
  });
});
