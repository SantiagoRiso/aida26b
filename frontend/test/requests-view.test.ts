import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { VirtualOccurrence } from '@shared/ssot/query-types';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import { filterParam } from '@shared/ssot/list-protocol';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  approveAppointment: vi.fn(),
  transitionAppointment: vi.fn(),
}));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  getRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));
vi.mock('@/api/ledger', () => ({ getBalance: vi.fn().mockResolvedValue({ ok: true, data: { balance_ars: '0.00' } }) }));
vi.mock('@/api/scheduling', () => ({ getAvailability: vi.fn().mockResolvedValue({ ok: true, data: { slots: [] } }) }));

import RequestsView from '@/views/staff/RequestsView.vue';

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

// The triage list keeps its professional, order and search in the URL, so it needs a router.
async function makeRouter(initialUrl = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push(initialUrl);
  await router.isReady();
  return router;
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

    const wrapper = mount(RequestsView, { global: { plugins: [await makeRouter(), makeI18n()] } });
    await flushPromises();

    expect(wrapper.findAll('tbody tr[role="button"]')).toHaveLength(1);
  });
});

// The detail drawer shows the professional's schedule for the requested day only. A bare date_to
// covers that whole day server-side, so naming the next day would drag a second day into the view.
describe('RequestsView — detail day range', () => {
  it('loads exactly the requested day, both bounds on that date', async () => {
    const request = makeAppt('r1');
    mockedList.mockResolvedValue({ ok: true, data: [request] });

    const wrapper = mount(RequestsView, {
      global: { plugins: [await makeRouter(), makeI18n()], stubs: { CalendarView: true } },
    });
    await flushPromises();
    await wrapper.get('tbody tr[role="button"]').trigger('click');
    await flushPromises();

    const day = request.starts_at.slice(0, 10);
    const dayCall = mockedList.mock.calls
      .map(([filters]) => filters)
      .find((filters) => filters?.professional_user_id === request.professional_user_id);
    expect(dayCall?.date_from).toBe(day);
    expect(dayCall?.date_to).toBe(day);
  });
});

// Ordering is the server's: the screen never re-sorts what came back, so a header click has to
// reach the request or it does nothing at all.
describe('RequestsView — column ordering', () => {
  function headerFor(wrapper: ReturnType<typeof mount>, label: string) {
    const th = wrapper.findAll('th').find((cell) => cell.text().startsWith(label));
    expect(th, `no header for ${label}`).toBeTruthy();
    return th!;
  }

  function lastRequestList() {
    const calls = mockedList.mock.calls.filter(([filters]) => filters?.state === 'requested');
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0];
  }

  it('clicking a sortable header asks the server for that order and reverses on a second click', async () => {
    mockedList.mockResolvedValue({ ok: true, data: [makeAppt('r1')] });
    const router = await makeRouter();
    const wrapper = mount(RequestsView, { global: { plugins: [router, makeI18n()] } });
    await flushPromises();

    await headerFor(wrapper, es.calendar.priceLabel).get('button').trigger('click');
    await flushPromises();
    expect(lastRequestList()).toMatchObject({ sort: 'price', dir: 'asc' });
    expect(router.currentRoute.value.query).toMatchObject({ sort: 'price', dir: 'asc' });

    await headerFor(wrapper, es.calendar.priceLabel).get('button').trigger('click');
    await flushPromises();
    expect(lastRequestList()).toMatchObject({ sort: 'price', dir: 'desc' });
  });

  it('reports the active column through aria-sort', async () => {
    mockedList.mockResolvedValue({ ok: true, data: [makeAppt('r1')] });
    const wrapper = mount(RequestsView, { global: { plugins: [await makeRouter(), makeI18n()] } });
    await flushPromises();

    expect(headerFor(wrapper, es.calendar.dateLabel).attributes('aria-sort')).toBe('none');
    await headerFor(wrapper, es.calendar.dateLabel).get('button').trigger('click');
    await flushPromises();
    expect(headerFor(wrapper, es.calendar.dateLabel).attributes('aria-sort')).toBe('ascending');
  });

  it('a pasted link seeds the first request with its order and professional', async () => {
    mockedList.mockResolvedValue({ ok: true, data: [makeAppt('r1')] });
    const router = await makeRouter(`/?sort=starts_at&dir=desc&${filterParam('professional_user_id')}=7`);
    mount(RequestsView, { global: { plugins: [router, makeI18n()] } });
    await flushPromises();

    expect(lastRequestList()).toMatchObject({
      sort: 'starts_at',
      dir: 'desc',
      professional_user_id: '7',
      state: 'requested',
    });
  });

  it('a column the server does not sort by never reaches the request', async () => {
    mockedList.mockResolvedValue({ ok: true, data: [makeAppt('r1')] });
    mount(RequestsView, { global: { plugins: [await makeRouter('/?sort=client_name&dir=asc'), makeI18n()] } });
    await flushPromises();

    expect(lastRequestList()?.sort).toBeUndefined();
  });
});
