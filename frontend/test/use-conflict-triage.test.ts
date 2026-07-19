import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { VirtualOccurrence } from '@shared/ssot/query-types';
import { useConflictTriage } from '@/composables/useConflictTriage';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  transitionAppointment: vi.fn(),
  approveAppointment: vi.fn(),
  ignoreAppointmentConflict: vi.fn(),
}));

const mockedList = vi.mocked(listAppointments);

const NOW = new Date();

function makeAppt(id: string, overrides: Partial<Appointment> = {}): Appointment {
  const startsAt = new Date(NOW.getTime() + 86400000).toISOString();
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
    in_conflict: true,
    ...overrides,
  };
}

function makeVirtual(overrides: Partial<VirtualOccurrence> = {}): VirtualOccurrence {
  const startsAt = new Date(NOW.getTime() + 2 * 86400000).toISOString();
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
    in_conflict: true,
    ...overrides,
  };
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/staff/calendar', name: 'staff-calendar', component: { template: '<div/>' } }],
  });
}

function mountTriage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = makeRouter();
  let triage!: ReturnType<typeof useConflictTriage>;
  const Host = defineComponent({
    setup() {
      triage = useConflictTriage();
      return () => null;
    },
  });
  const wrapper = mount(Host, { global: { plugins: [pinia, router] } });
  return { triage, wrapper };
}

beforeEach(() => {
  mockedList.mockReset();
});

// An in-conflict virtual has no materialized row: ignore/resolve/approve here act on appt.id
// directly with no materialize-on-action wiring, so a leaked virtual would offer an action that 404s.
describe('useConflictTriage — virtual filter', () => {
  it('excludes virtual occurrences from the actionable conflict list, even when flagged in_conflict', async () => {
    mockedList.mockResolvedValue({
      ok: true,
      data: [makeAppt('c1'), makeVirtual()],
    });

    const { triage } = mountTriage();
    await triage.loadConflicts();

    expect(triage.conflictTurnos.value).toHaveLength(1);
    expect(triage.conflictTurnos.value.map((a) => a.id)).toEqual(['c1']);
    expect(triage.conflictTurnos.value.every((a) => a.is_virtual !== true)).toBe(true);
  });
});
