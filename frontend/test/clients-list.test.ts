import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { structure } from '@shared/ssot/structure';
import { LIST_DEFAULT_LIMIT, filterParam } from '@shared/ssot/list-protocol';
import type { Role } from '@shared/types/roles';

// Only the network-calling exports are stubbed; the query vocabulary the URL and the request
// share stays the real one.
vi.mock('@/api/crud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/crud')>()),
  listRows: vi.fn(),
}));

vi.mock('@/api/appointments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/appointments')>()),
  listRelatedClientIds: vi.fn(),
}));

import ClientsView from '@/views/staff/ClientsView.vue';
import { listRows } from '@/api/crud';
import { listRelatedClientIds } from '@/api/appointments';

const listRowsMock = listRows as ReturnType<typeof vi.fn>;
const relatedIdsMock = listRelatedClientIds as ReturnType<typeof vi.fn>;

const clientColumns = structure.tables.clients.columns;
const nameLabel = clientColumns.display_name.label.es;
const dniLabel = clientColumns.dni.label.es;

const bart = { id: '4', display_name: 'Bart Simpson', dni: '30440001', email: null, phone: null };
const selma = { id: '9', display_name: 'Selma Bouvier', dni: '11220003', email: null, phone: null };

function okPage(rows: Array<Record<string, unknown>>, total = rows.length, limit = LIST_DEFAULT_LIMIT) {
  return { ok: true, data: rows, meta: { page: 1, limit, total } };
}

async function mountView(initialUrl = '/', role: Role = 'Admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'staff',
    email: null,
    role,
    business_id: 5,
    is_active: true,
    must_change_password: false,
  };

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push(initialUrl);
  await router.isReady();

  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  const wrapper = mount(ClientsView, {
    global: { plugins: [pinia, router, i18n], stubs: { DetailPanel: true } },
  });
  await flushPromises();
  return { wrapper, router };
}

function lastRequest(): Record<string, unknown> {
  const calls = listRowsMock.mock.calls.filter((call) => call[0] === 'clients');
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1];
}

function rowsOf(wrapper: Awaited<ReturnType<typeof mountView>>['wrapper']) {
  return wrapper.findAll('tr.virtualized-row');
}

// Real timers: @vue/test-utils' flushPromises schedules on the same host timers vitest fakes.
const DEBOUNCE_GRACE_MS = 400;
const debounceElapsed = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_GRACE_MS));

beforeEach(() => {
  listRowsMock.mockReset();
  listRowsMock.mockResolvedValue(okPage([bart, selma]));
  relatedIdsMock.mockReset();
  relatedIdsMock.mockResolvedValue({ ok: true, data: [] });
});

describe('ClientsView — the server pages and filters the list', () => {
  it('asks for one page sorted by name, never the whole table', async () => {
    await mountView();

    expect(lastRequest()).toMatchObject({ page: 1, sort: 'display_name', dir: 'asc' });
    // The old view fetched a fixed 500-row slab; the page size is the server's to choose.
    expect(lastRequest().limit).toBeUndefined();
  });

  it('typing a name searches server-side and lands in the URL, not in a local filter', async () => {
    const { wrapper, router } = await mountView();
    const requestsBefore = listRowsMock.mock.calls.length;

    await wrapper.get(`input[aria-label="${nameLabel}"]`).setValue('simpson');
    expect(listRowsMock.mock.calls.length).toBe(requestsBefore);

    await debounceElapsed();
    await flushPromises();

    expect(lastRequest()).toMatchObject({ page: 1, filters: { display_name: 'simpson', dni: '' } });
    expect(router.currentRoute.value.query[filterParam('display_name')]).toBe('simpson');
  });

  it('searches by DNI through its own filter field', async () => {
    const { wrapper } = await mountView();

    await wrapper.get(`input[aria-label="${dniLabel}"]`).setValue('30440001');
    await debounceElapsed();
    await flushPromises();

    expect(lastRequest()).toMatchObject({ filters: { dni: '30440001' } });
  });

  it('renders exactly the rows the server returned — no second filtering pass in memory', async () => {
    listRowsMock.mockResolvedValue(okPage([selma]));
    const { wrapper } = await mountView();

    await wrapper.get(`input[aria-label="${nameLabel}"]`).setValue('bart');
    await debounceElapsed();
    await flushPromises();

    expect(rowsOf(wrapper)).toHaveLength(1);
    expect(wrapper.text()).toContain(selma.display_name);
  });

  it('a searching URL seeds the very first request', async () => {
    await mountView(`/?page=2&sort=dni&dir=desc&${filterParam('display_name')}=bouvier`);

    expect(lastRequest()).toMatchObject({
      page: 2,
      sort: 'dni',
      dir: 'desc',
      filters: { display_name: 'bouvier' },
    });
  });

  it('sorting by a column header writes sort and dir to the URL', async () => {
    const { wrapper, router } = await mountView();

    const dniHeader = wrapper.findAll('th').find((th) => th.text().includes(dniLabel));
    await dniHeader!.trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.query).toMatchObject({ sort: 'dni', dir: 'asc' });
    expect(lastRequest()).toMatchObject({ sort: 'dni', dir: 'asc' });
  });
});

describe('ClientsView — pagination', () => {
  it('shows the pager once the total exceeds one page and requests the next page', async () => {
    listRowsMock.mockResolvedValue(okPage([bart, selma], 120, 50));
    const { wrapper, router } = await mountView();

    const next = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    expect(next).toBeDefined();

    await next!.trigger('click');
    await flushPromises();

    expect(lastRequest()).toMatchObject({ page: 2 });
    expect(router.currentRoute.value.query.page).toBe('2');
  });

  it('hides the pager when everything fits on one page', async () => {
    const { wrapper } = await mountView();

    expect(wrapper.findAll('button').some((b) => b.text() === es.generic.next)).toBe(false);
  });

  it('reports the server total, not the number of rows on screen', async () => {
    listRowsMock.mockResolvedValue(okPage([bart, selma], 120, 50));
    const { wrapper } = await mountView();

    expect(wrapper.text()).toContain('120');
  });
});

describe('ClientsView — prior-relationship scoping', () => {
  it('hides clients the viewer has no relationship with, and reveals them on request', async () => {
    relatedIdsMock.mockResolvedValue({ ok: true, data: [9] });
    const { wrapper } = await mountView('/', 'Professional');

    expect(rowsOf(wrapper)).toHaveLength(1);
    expect(wrapper.text()).toContain(selma.display_name);
    expect(wrapper.text()).not.toContain(bart.display_name);

    const includeUnrelated = wrapper
      .findAll('label')
      .find((l) => l.text() === es.clients.includeUnrelated);
    await includeUnrelated!.get('input[type="checkbox"]').setValue(true);

    expect(rowsOf(wrapper)).toHaveLength(2);
    expect(wrapper.text()).toContain(bart.display_name);
    expect(wrapper.text()).toContain(es.clients.noRelationship);
  });

  it('shows an Admin every client, with no relationship toggle and no relatedness lookup', async () => {
    const { wrapper } = await mountView('/', 'Admin');

    expect(rowsOf(wrapper)).toHaveLength(2);
    expect(relatedIdsMock).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain(es.clients.includeUnrelated);
  });

  it('the relationship set is fetched once, not again on every page', async () => {
    relatedIdsMock.mockResolvedValue({ ok: true, data: [4, 9] });
    listRowsMock.mockResolvedValue(okPage([bart, selma], 120, 50));
    const { wrapper } = await mountView('/', 'Receptionist');

    const next = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    await next!.trigger('click');
    await flushPromises();

    expect(relatedIdsMock).toHaveBeenCalledTimes(1);
  });
});
