import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { structure } from '@shared/ssot/structure';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_MAX_PAGE,
  filterParam,
} from '@shared/ssot/list-protocol';
import type { ColumnDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import type { Role } from '@shared/types/roles';

// Only the network-calling exports are stubbed; the query vocabulary the URL and the request
// share stays the real one.
vi.mock('@/api/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/crud')>();
  return {
    ...actual,
    listRows: vi.fn(),
    getRow: vi.fn(),
    createRow: vi.fn(),
    updateRow: vi.fn(),
    deleteRow: vi.fn(),
  };
});

vi.mock('@/api/audit', () => ({ listAudit: vi.fn() }));

import GenericTable from '@/components/generic/GenericTable.vue';
import AuditView from '@/views/staff/AuditView.vue';
// The real serializer: if the URL and the request ever stop agreeing, this suite fails.
import { listRows, buildQuery } from '@/api/crud';
import type { ListParams } from '@/api/crud';
import { listAudit } from '@/api/audit';
import type { AuditFilters } from '@/api/audit';

const listRowsMock = listRows as ReturnType<typeof vi.fn>;
const listAuditMock = listAudit as ReturnType<typeof vi.fn>;

const serviceRow = {
  id: '1',
  name: 'Corte simple',
  description: null,
  default_duration_minutes: 30,
  default_price_ars: '500.00',
};

function okPage(total = 1) {
  return { ok: true, data: [serviceRow], meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total } };
}

async function makePlugins(initialUrl = '/', role: Role = 'Admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'admin',
    email: null,
    role,
    business_id: null,
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
  return { pinia, router, i18n };
}

function mountTable(
  plugins: Awaited<ReturnType<typeof makePlugins>>,
  tableKey: TableKey = 'services' as TableKey,
) {
  const { pinia, router, i18n } = plugins;
  return mount(GenericTable, {
    props: { tableKey },
    global: { plugins: [pinia, router, i18n] },
  });
}

// FK label lookups hit listRows for other tables, so the assertions look at the last request
// for the table under test.
function requestsFor(table: string): ListParams[] {
  return listRowsMock.mock.calls.filter((call) => call[0] === table).map((call) => call[1]);
}

function lastRequest(table = 'services'): ListParams {
  const calls = requestsFor(table);
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

type Wrapper = ReturnType<typeof mountTable>;

// GenericTable renders its own "Agregar <entidad>" create button before the filter editor, so
// the filter editor's button is matched by its exact label.
async function addFilter(wrapper: Wrapper, field: string) {
  await wrapper.get(`select[aria-label="${es.generic.selectColumnAria}"]`).setValue(field);
  const addButton = wrapper.findAll('button').find((b) => b.text() === es.generic.add);
  await addButton!.trigger('click');
}

// Real timers: @vue/test-utils' flushPromises schedules on the same host timers vitest fakes.
const DEBOUNCE_GRACE_MS = 400;
const debounceElapsed = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_GRACE_MS));

beforeEach(() => {
  listRowsMock.mockReset();
  listRowsMock.mockResolvedValue(okPage());
  listAuditMock.mockReset();
  listAuditMock.mockResolvedValue({ ok: true, data: [], meta: { page: 1, limit: 50, total: 0 } });
});

describe('GenericTable — list state restores from the URL', () => {
  it('a pasted URL seeds the very first request with its page, sort, dir and filters', async () => {
    const plugins = await makePlugins(
      `/?page=3&sort=name&dir=desc&${filterParam('name')}=${encodeURIComponent('!corte')}`,
    );
    mountTable(plugins);
    await flushPromises();

    expect(lastRequest()).toMatchObject({
      page: 3,
      sort: 'name',
      dir: 'desc',
      filters: { name: '!corte' },
    });
  });

  it('a restored filter renders as an editable filter row, not just as a request param', async () => {
    const plugins = await makePlugins(`/?${filterParam('name')}=corte`);
    const wrapper = mountTable(plugins);
    await flushPromises();

    const input = wrapper.get(`input[placeholder="${es.generic.filterPlaceholder}"]`);
    expect((input.element as HTMLInputElement).value).toBe('corte');
  });

  it('a restored limit is honoured by the request', async () => {
    const plugins = await makePlugins('/?limit=10');
    mountTable(plugins);
    await flushPromises();

    expect(lastRequest()).toMatchObject({ limit: 10 });
  });
});

describe('GenericTable — state changes are written back to the URL', () => {
  it('sorting writes sort + dir and replaces rather than pushes', async () => {
    const plugins = await makePlugins();
    const replace = vi.spyOn(plugins.router, 'replace');
    const push = vi.spyOn(plugins.router, 'push');
    const wrapper = mountTable(plugins);
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find((th) => th.text().includes('Nombre'));
    await nameHeader!.get('button').trigger('click');
    await flushPromises();

    expect(plugins.router.currentRoute.value.query).toMatchObject({ sort: 'name', dir: 'asc' });
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    await nameHeader!.get('button').trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query).toMatchObject({ sort: 'name', dir: 'desc' });
  });

  it('paging writes page, and page 1 leaves no page key behind', async () => {
    listRowsMock.mockResolvedValue({
      ok: true,
      data: [serviceRow],
      meta: { page: 1, limit: 20, total: 60 },
    });
    const plugins = await makePlugins();
    const wrapper = mountTable(plugins);
    await flushPromises();

    const next = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    await next!.trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.page).toBe('2');

    const previous = wrapper.findAll('button').find((b) => b.text() === es.generic.previous);
    await previous!.trigger('click');
    await flushPromises();
    expect(plugins.router.currentRoute.value.query.page).toBeUndefined();
  });

  it('typing in a filter is debounced: one URL write and one request, not one per keystroke', async () => {
    const plugins = await makePlugins();
    const replace = vi.spyOn(plugins.router, 'replace');
    const wrapper = mountTable(plugins);
    await flushPromises();

    const requestsAfterMount = requestsFor('services').length;
    await addFilter(wrapper, 'name');

    const input = wrapper.get(`input[placeholder="${es.generic.filterPlaceholder}"]`);
    for (const value of ['c', 'co', 'cor', 'cort', 'corte']) {
      await input.setValue(value);
    }

    expect(replace).not.toHaveBeenCalled();
    expect(requestsFor('services').length).toBe(requestsAfterMount);

    await debounceElapsed();
    await flushPromises();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(requestsFor('services').length).toBe(requestsAfterMount + 1);
    expect(plugins.router.currentRoute.value.query[filterParam('name')]).toBe('corte');
  });

  it('a blank filter never appears in the URL as an empty key', async () => {
    const plugins = await makePlugins();
    const wrapper = mountTable(plugins);
    await flushPromises();

    await addFilter(wrapper, 'name');
    await debounceElapsed();
    await flushPromises();

    expect(plugins.router.currentRoute.value.query[filterParam('name')]).toBeUndefined();
    expect(plugins.router.currentRoute.value.fullPath).not.toContain('filter_');
  });

  it('query keys this list does not own survive a state change', async () => {
    const plugins = await makePlugins('/?tab=historial');
    const wrapper = mountTable(plugins);
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find((th) => th.text().includes('Nombre'));
    await nameHeader!.get('button').trigger('click');
    await flushPromises();

    expect(plugins.router.currentRoute.value.query).toMatchObject({ tab: 'historial', sort: 'name' });
  });
});

describe('GenericTable — hostile query values are clamped, not forwarded', () => {
  it('garbage page/limit/dir fall back to the defaults and the view still renders', async () => {
    const plugins = await makePlugins('/?page=abc&limit=notanumber&dir=sideways');
    const wrapper = mountTable(plugins);
    await flushPromises();

    expect(lastRequest()).toMatchObject({ page: 1, dir: 'asc' });
    expect(lastRequest().limit).toBeUndefined();
    expect(wrapper.text()).toContain('Corte simple');
  });

  it('out-of-range page and limit are clamped to the same bounds the server enforces', async () => {
    const plugins = await makePlugins(`/?page=99999&limit=${LIST_MAX_LIMIT + 1}`);
    mountTable(plugins);
    await flushPromises();

    expect(lastRequest()).toMatchObject({ page: LIST_MAX_PAGE, limit: LIST_MAX_LIMIT });
  });

  it('a negative page becomes page 1', async () => {
    const plugins = await makePlugins('/?page=-5');
    mountTable(plugins);
    await flushPromises();

    expect(lastRequest()).toMatchObject({ page: 1 });
  });

  it('a sort column the table does not declare sortable is dropped', async () => {
    const cols = structure.tables.services.columns as Record<string, ColumnDef>;
    expect(cols.description?.sortable).toBeFalsy();

    const plugins = await makePlugins('/?sort=description');
    mountTable(plugins);
    await flushPromises();

    expect(lastRequest().sort).toBeUndefined();
  });

  it('a filter naming a column the table does not declare filterable is dropped', async () => {
    const plugins = await makePlugins(`/?${filterParam('drop table users')}=1`);
    const wrapper = mountTable(plugins);
    await flushPromises();

    expect(lastRequest().filters).toEqual({});
    expect(wrapper.text()).toContain('Corte simple');
  });

  it('a repeated key takes the first value instead of sending an array', async () => {
    const plugins = await makePlugins('/?page=2&page=7');
    mountTable(plugins);
    await flushPromises();

    expect(lastRequest()).toMatchObject({ page: 2 });
  });
});

describe('GenericTable — switching tables clears the previous table state', () => {
  it('the previous table filters and sort leave the URL on a table switch', async () => {
    const plugins = await makePlugins(`/?page=2&sort=name&dir=desc&${filterParam('name')}=corte`);
    const wrapper = mountTable(plugins);
    await flushPromises();

    listRowsMock.mockResolvedValue({
      ok: true,
      data: [{ id: '1', display_name: 'Dra. Ana', bio: null }],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    });
    await wrapper.setProps({ tableKey: 'professionals' as TableKey });
    await flushPromises();

    expect(plugins.router.currentRoute.value.query).toEqual({});
    expect(lastRequest('professionals')).toMatchObject({ page: 1, filters: {} });
    expect(lastRequest('professionals').sort).toBeUndefined();
    // The filter editor is rebuilt for the new table rather than keeping the old row.
    expect(wrapper.find(`input[placeholder="${es.generic.filterPlaceholder}"]`).exists()).toBe(false);
  });
});

describe('GenericTable — browser navigation re-reads the URL', () => {
  it('going back to the previous URL restores that view and refetches', async () => {
    const plugins = await makePlugins();
    const wrapper = mountTable(plugins);
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find((th) => th.text().includes('Nombre'));
    await nameHeader!.get('button').trigger('click');
    await flushPromises();
    expect(lastRequest()).toMatchObject({ sort: 'name' });

    await plugins.router.replace('/');
    await flushPromises();

    expect(lastRequest().sort).toBeUndefined();
  });
});

describe('AuditView — its own list state is URL-bound too', () => {
  function mountAudit(plugins: Awaited<ReturnType<typeof makePlugins>>) {
    const { pinia, router, i18n } = plugins;
    return mount(AuditView, { global: { plugins: [pinia, router, i18n] } });
  }

  it('restores filters and page from the URL on the first search', async () => {
    const plugins = await makePlugins(
      `/?page=2&${filterParam('outcome')}=denied&${filterParam('entity_type')}=appointments`,
    );
    mountAudit(plugins);
    await flushPromises();

    expect(listAuditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'denied', entity_type: 'appointments' }),
      2,
      LIST_DEFAULT_LIMIT,
      { sort: undefined, dir: 'asc' },
    );
  });

  it('submitting the form replaces the URL with the active filters and returns to page 1', async () => {
    const plugins = await makePlugins('/?page=4');
    const replace = vi.spyOn(plugins.router, 'replace');
    const push = vi.spyOn(plugins.router, 'push');
    const wrapper = mountAudit(plugins);
    await flushPromises();

    await wrapper.get(`select[aria-label="${es.audit.outcome}"]`).setValue('denied');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(plugins.router.currentRoute.value.query).toEqual({ [filterParam('outcome')]: 'denied' });
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(listAuditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'denied' }),
      1,
      LIST_DEFAULT_LIMIT,
      { sort: undefined, dir: 'asc' },
    );
  });

  it('clearing the filters empties the URL', async () => {
    const plugins = await makePlugins(`/?${filterParam('event_type')}=login`);
    const wrapper = mountAudit(plugins);
    await flushPromises();

    const clear = wrapper.findAll('button').find((b) => b.text() === es.audit.clear);
    await clear!.trigger('click');
    await flushPromises();

    expect(plugins.router.currentRoute.value.query).toEqual({});
  });

  // A shared link outlives the filters it names, so an unoffered one is dropped rather than passed
  // through to an endpoint that would answer it.
  it('a filter the view does not offer is ignored and does not break it', async () => {
    const plugins = await makePlugins(`/?${filterParam('actor_user_id')}=abc`);
    const wrapper = mountAudit(plugins);
    await flushPromises();

    const sentFilters = listAuditMock.mock.calls.at(-1)?.[0] as AuditFilters;
    expect(sentFilters).not.toHaveProperty('actor_user_id');
    expect(sentFilters.actor_username).toBeUndefined();
    expect(wrapper.text()).toContain(es.audit.title);
  });
});

describe('list URL vocabulary is the shared one', () => {
  it('the URL a sorted, filtered, paged view leaves behind is exactly what the API layer would send', async () => {
    const plugins = await makePlugins();
    const wrapper = mountTable(plugins);
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find((th) => th.text().includes('Nombre'));
    await nameHeader!.get('button').trigger('click');
    await flushPromises();

    const written = plugins.router.currentRoute.value.query as Record<string, string>;
    expect(`?${new URLSearchParams(written).toString()}`).toBe(
      buildQuery({ sort: 'name', dir: 'asc' }),
    );
  });
});

describe('AuditView — column ordering is server-side and URL-bound', () => {
  function mountAudit(plugins: Awaited<ReturnType<typeof makePlugins>>) {
    const { pinia, router, i18n } = plugins;
    return mount(AuditView, { global: { plugins: [pinia, router, i18n] } });
  }

  // The table only renders once there is a row to put in it, so the headers only exist then.
  beforeEach(() => {
    listAuditMock.mockResolvedValue({
      ok: true,
      data: [{
        id: '1', actor_user_id: '7', actor_username: 'recep_ana', event_type: 'appointment_requested',
        entity_type: 'appointments', entity_id: '3', outcome: 'success',
        ip: null, details: null, created_at: '2026-01-01T12:00:00.000Z',
      }],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    });
  });

  function header(wrapper: ReturnType<typeof mountAudit>, label: string) {
    const th = wrapper.findAll('th').find((cell) => cell.text().startsWith(label));
    expect(th, `no header for ${label}`).toBeTruthy();
    return th!;
  }

  it('clicking a header asks the API for that order and reverses on a second click', async () => {
    const plugins = await makePlugins();
    const wrapper = mountAudit(plugins);
    await flushPromises();

    await header(wrapper, es.audit.colEvent).get('button').trigger('click');
    await flushPromises();
    expect(listAuditMock.mock.calls.at(-1)?.[3]).toEqual({ sort: 'event_type', dir: 'asc' });
    expect(plugins.router.currentRoute.value.query).toMatchObject({ sort: 'event_type', dir: 'asc' });

    await header(wrapper, es.audit.colEvent).get('button').trigger('click');
    await flushPromises();
    expect(listAuditMock.mock.calls.at(-1)?.[3]).toEqual({ sort: 'event_type', dir: 'desc' });
  });

  it('reports the active column through aria-sort', async () => {
    const plugins = await makePlugins();
    const wrapper = mountAudit(plugins);
    await flushPromises();

    expect(header(wrapper, es.audit.outcome).attributes('aria-sort')).toBe('none');
    await header(wrapper, es.audit.outcome).get('button').trigger('click');
    await flushPromises();
    expect(header(wrapper, es.audit.outcome).attributes('aria-sort')).toBe('ascending');
  });

  it('re-sorting returns to page 1', async () => {
    const plugins = await makePlugins('/?page=4');
    const wrapper = mountAudit(plugins);
    await flushPromises();

    await header(wrapper, es.audit.colActor).get('button').trigger('click');
    await flushPromises();

    expect(listAuditMock.mock.calls.at(-1)?.[1]).toBe(1);
    expect(plugins.router.currentRoute.value.query.page).toBeUndefined();
  });

  it('a column the audit endpoint does not sort by is dropped rather than forwarded', async () => {
    const plugins = await makePlugins('/?sort=ip&dir=desc');
    mountAudit(plugins);
    await flushPromises();

    expect(listAuditMock.mock.calls.at(-1)?.[3]).toEqual({ sort: undefined, dir: 'desc' });
  });
});
