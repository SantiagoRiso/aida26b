import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { listAppointments } from '@/api/appointments';
import { listAudit } from '@/api/audit';
import type { Appointment, AppointmentListFilters } from '@/api/appointments';
import type { VirtualOccurrence } from '@shared/ssot/query-types';
import { useAuthStore } from '@/stores/auth';
import { useAdminDashboard } from '@/composables/useAdminDashboard';
import { useProfessionalDashboard } from '@/composables/useProfessionalDashboard';
import { useReceptionistDashboard } from '@/composables/useReceptionistDashboard';

// Stat tiles / summary lists on the three staff dashboards — each patched to drop virtual
// (un-materialized recurring) occurrences from the server's mixed list response.
vi.mock('@/api/appointments', () => ({ listAppointments: vi.fn() }));
vi.mock('@/api/audit', () => ({ listAudit: vi.fn() }));

const mockedList = vi.mocked(listAppointments);
const mockedAudit = vi.mocked(listAudit);

const NOW = new Date();

function makeAppt(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const startsAt = NOW.toISOString();
  return {
    id,
    client_user_id: '3',
    professional_user_id: '7',
    resource_id: null,
    service_id: 's1',
    starts_at: startsAt,
    duration_minutes: 30,
    ends_at: startsAt,
    state: 'scheduled',
    name: null,
    description: null,
    price: '1500.00',
    override_conflict: false,
    override_actor_id: null,
    staff_note: null,
    created_at: startsAt,
    updated_at: startsAt,
    conflict_ignored: false,
    series_id: null,
    occurrence_date: null,
    ...overrides,
  };
}

function makeVirtual(overrides: Partial<VirtualOccurrence> = {}): VirtualOccurrence {
  const startsAt = new Date(NOW.getTime() + 86400000).toISOString();
  return {
    id: null,
    series_id: '9',
    occurrence_date: startsAt.slice(0, 10),
    client_user_id: '3',
    professional_user_id: '7',
    service_id: 's1',
    resource_id: null,
    starts_at: startsAt,
    duration_minutes: 30,
    price: '1500.00',
    state: 'scheduled',
    name: null,
    description: null,
    is_virtual: true,
    in_conflict: false,
    service_name: 'Servicio',
    professional_name: 'Profesional',
    client_name: 'Cliente',
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mockedList.mockReset();
  mockedAudit.mockReset();
  mockedAudit.mockResolvedValue({ ok: true, data: [] });
});

describe('useAdminDashboard — virtual filter', () => {
  it('counts only real appointments toward the today stat, ignoring virtual occurrences the date range folds in', async () => {
    mockedList.mockImplementation((filters?: AppointmentListFilters) => {
      if (filters?.state === 'requested') return Promise.resolve({ ok: true, data: [], meta: { page: 1, limit: 50, total: 4 } });
      return Promise.resolve({ ok: true, data: [makeAppt('1'), makeAppt('2'), makeVirtual()] });
    });

    const { adminTodayCount, adminPendingCount, loadAdmin } = useAdminDashboard();
    await loadAdmin();

    expect(adminTodayCount.value).toBe(2);
    // Control: the pending stat reads the server's own count directly (virtuals are always
    // 'scheduled', never 'requested', so meta.total there is already real-only).
    expect(adminPendingCount.value).toBe(4);
  });
});

describe('useProfessionalDashboard — virtual filter', () => {
  it('drops virtual occurrences from both the upcoming and pending lists', async () => {
    const auth = useAuthStore();
    auth.user = {
      id: 7, username: 'pro', email: null, role: 'Professional',
      business_id: 1, is_active: true, must_change_password: false,
    };

    mockedList.mockImplementation((filters?: AppointmentListFilters) => {
      if (filters?.state === 'requested') {
        return Promise.resolve({ ok: true, data: [makeAppt('p1'), makeVirtual()] });
      }
      return Promise.resolve({ ok: true, data: [makeAppt('u1'), makeVirtual()] });
    });

    const { proUpcoming, proPending, loadProfessional } = useProfessionalDashboard();
    await loadProfessional();

    expect(proUpcoming.value.map((a) => a.id)).toEqual(['u1']);
    expect(proPending.value.map((a) => a.id)).toEqual(['p1']);
  });
});

// "Today" is the business day in Argentina, not the device's UTC day. This instant is late evening
// in Buenos Aires but already the next date in UTC, so a UTC-derived bound names the wrong day —
// and the assertion holds whatever zone the suite runs in.
describe('staff dashboards — "today" is the business day', () => {
  const LATE_EVENING_IN_ARGENTINA = new Date('2026-07-21T02:30:00.000Z');
  const BUSINESS_DAY = '2026-07-20';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(LATE_EVENING_IN_ARGENTINA);
    mockedList.mockResolvedValue({ ok: true, data: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function todayFilters() {
    return mockedList.mock.calls.map(([filters]) => filters).find((filters) => filters?.state !== 'requested');
  }

  it('admin bounds the today tile to that single business day', async () => {
    await useAdminDashboard().loadAdmin();
    expect(todayFilters()).toMatchObject({ date_from: BUSINESS_DAY, date_to: BUSINESS_DAY });
  });

  it('receptionist bounds the today list to that single business day', async () => {
    await useReceptionistDashboard().loadReceptionist();
    expect(todayFilters()).toMatchObject({ date_from: BUSINESS_DAY, date_to: BUSINESS_DAY });
  });

  it('professional lists upcoming turnos from that business day, not the UTC one', async () => {
    const auth = useAuthStore();
    auth.user = {
      id: 7, username: 'pro', email: null, role: 'Professional',
      business_id: 1, is_active: true, must_change_password: false,
    };
    await useProfessionalDashboard().loadProfessional();
    expect(todayFilters()).toMatchObject({ date_from: BUSINESS_DAY });
  });
});

describe('useReceptionistDashboard — virtual filter', () => {
  it('drops virtual occurrences from both the today and pending lists', async () => {
    mockedList.mockImplementation((filters?: AppointmentListFilters) => {
      if (filters?.state === 'requested') {
        return Promise.resolve({ ok: true, data: [makeAppt('r1'), makeVirtual()] });
      }
      return Promise.resolve({ ok: true, data: [makeAppt('t1'), makeVirtual()] });
    });

    const { recToday, recPending, loadReceptionist } = useReceptionistDashboard();
    await loadReceptionist();

    expect(recToday.value.map((a) => a.id)).toEqual(['t1']);
    expect(recPending.value.map((a) => a.id)).toEqual(['r1']);
  });
});
