import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { VirtualOccurrence } from '@shared/ssot/query-types';
import { useClientAppointments } from '@/composables/useClientAppointments';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  transitionAppointment: vi.fn(),
}));

const mockedList = vi.mocked(listAppointments);

const NOW = new Date();

function makeAppt(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const startsAt = NOW.toISOString();
  return {
    id,
    client_user_id: '5',
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
    client_user_id: '5',
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
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  mockedList.mockReset();
});

// A virtual has no row yet — this list's cancel action reads appt.id directly, so it must never
// surface here, whether in the raw list or either of the pending/history splits derived from it.
describe('useClientAppointments — virtual filter', () => {
  it('excludes a virtual occurrence from the loaded list and its open/closed splits', async () => {
    mockedList.mockResolvedValue({
      ok: true,
      data: [makeAppt('o1', { state: 'scheduled' }), makeAppt('h1', { state: 'completed' }), makeVirtual()],
    });

    const { appointments, pendingAppointments, historyAppointments, loadAppointments } = useClientAppointments(5);
    await loadAppointments();

    expect(appointments.value).toHaveLength(2);
    expect(appointments.value.every((a) => a.is_virtual !== true)).toBe(true);
    // The virtual is always 'scheduled' (an open state) — a leak here would show up as a
    // phantom pending row, not just an inflated total.
    expect(pendingAppointments.value.map((a) => a.id)).toEqual(['o1']);
    expect(historyAppointments.value.map((a) => a.id)).toEqual(['h1']);
  });
});
