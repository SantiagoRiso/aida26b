import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { VirtualOccurrence } from '@shared/ssot/query-types';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  approveAppointment: vi.fn(),
  transitionAppointment: vi.fn(),
}));
vi.mock('@/api/crud', () => ({ listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }) }));

import RequestsView from '@/views/staff/RequestsView.vue';

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

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
    state: 'requested',
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
    in_conflict: false,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetFkOptionsCache();
  mockedList.mockReset();
});

// A virtual occurrence is always 'scheduled', never 'requested', so this filter is defensive
// typing rather than an expected runtime case — approve/reject act on appt.id directly, with no
// materialize-on-action wiring, so a leaked virtual here would offer an action that 404s.
describe('RequestsView — virtual filter', () => {
  it('never lists a virtual occurrence among pending requests', async () => {
    mockedList.mockResolvedValue({ ok: true, data: [makeAppt('r1'), makeVirtual()] });

    const wrapper = mount(RequestsView, { global: { plugins: [makeI18n()] } });
    await flushPromises();

    expect(wrapper.findAll('li[role="button"]')).toHaveLength(1);
  });
});
