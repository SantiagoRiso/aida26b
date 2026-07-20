import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';

import { structure } from '@shared/ssot/structure';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import type { ColumnDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import type { Role } from '@shared/types/roles';
import { resetFkOptionsCache } from '@/composables/useForeignKeyOptions';
import Skeleton from '@/components/shared/Skeleton.vue';
// The real query-string builder, not a reimplementation — a change to crud.ts's contract
// (e.g. a new reserved param) must fail this suite, not silently drift from it.
import { buildQuery } from '@/api/crud';

describe('listRows query serialization', () => {
  it('serializes page + sort + dir', () => {
    const q = buildQuery({ page: 2, sort: 'name', dir: 'desc' });
    expect(q).toContain('page=2');
    expect(q).toContain('sort=name');
    expect(q).toContain('dir=desc');
  });

  it('serializes a text filter as filter_<field>=<value>', () => {
    const q = buildQuery({ filters: { name: 'corte' } });
    expect(q).toContain('filter_name=corte');
    expect(q).not.toContain('filter_name=!');
  });

  it('serializes a negated text filter as filter_<field>=!<value>', () => {
    const q = buildQuery({ filters: { role: '!Client' } });
    expect(decodeURIComponent(q)).toContain('filter_role=!Client');
  });

  it('serializes a numeric range as filter_<field>=<min>,<max>', () => {
    const q = buildQuery({ filters: { default_duration_minutes: '10,60' } });
    expect(decodeURIComponent(q)).toContain('filter_default_duration_minutes=10,60');
  });

  it('empty filters produce no filter_ params', () => {
    const q = buildQuery({ filters: { name: '' } });
    expect(q).not.toContain('filter_name');
  });

  it('page 1 is omitted (backend defaults to page 1)', () => {
    const q = buildQuery({ page: 1 });
    expect(q).not.toContain('page=1');
  });
});

describe('SSOT metadata for services', () => {
  it('has filterable columns', () => {
    const cols = structure.tables.services.columns as Record<string, ColumnDef>;
    const filterable = Object.entries(cols).filter(([, c]) => c.filterable).map(([k]) => k);
    expect(filterable.length).toBeGreaterThan(0);
    expect(filterable).toContain('name');
  });

  it('has sortable columns', () => {
    const cols = structure.tables.services.columns as Record<string, ColumnDef>;
    const sortable = Object.entries(cols).filter(([, c]) => c.sortable).map(([k]) => k);
    expect(sortable.length).toBeGreaterThan(0);
    expect(sortable).toContain('name');
  });

  it('has crud.create = true', () => {
    expect(structure.tables.services.crud?.create).toBe(true);
  });
});

describe('SSOT metadata for clients', () => {
  it('has crud.create = false — no create button allowed', () => {
    expect(structure.tables.clients.crud?.create).toBe(false);
  });

  it('has filterable display_name column', () => {
    const cols = structure.tables.clients.columns as Record<string, ColumnDef>;
    expect(cols.display_name?.filterable).toBe(true);
  });
});

// Mock only the network-calling exports; keep buildQuery as the real implementation so the
// serialization tests above exercise the actual query-string contract, not a copy of it.
vi.mock('@/api/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/crud')>();
  return {
    ...actual,
    listRows: vi.fn().mockResolvedValue({
      ok: true,
      data: [
        { id: '1', name: 'Corte simple', description: null, default_duration_minutes: 30, default_price_ars: '500.00' },
      ],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    }),
    getRow: vi.fn(),
    createRow: vi.fn(),
    updateRow: vi.fn(),
    deleteRow: vi.fn(),
  };
});

function makePlugins(role: Role = 'Admin') {
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

  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });

  return { pinia, router, i18n };
}

import GenericTable from '@/components/generic/GenericTable.vue';

describe('GenericTable for services', () => {
  it('renders column headers from SSOT labels', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const ths = wrapper.findAll('th').map((th) => th.text());
    expect(ths.some((t) => t.includes('Nombre'))).toBe(true);
    expect(ths.some((t) => t.includes('Duración'))).toBe(true);
  });

  it('shows the create button when crud.create is true and role allows', async () => {
    const { pinia, router, i18n } = makePlugins('Admin');
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Agregar');
  });

  it('marks only sortable columns with cursor-pointer class', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const clickableThs = wrapper.findAll('th').filter((th) => th.classes().includes('cursor-pointer'));
    expect(clickableThs.length).toBeGreaterThan(0);

    const cols = structure.tables.services.columns as Record<string, ColumnDef>;
    const descCol = cols['description'];
    if (descCol && !descCol.sortable) {
      const nonClickable = wrapper.findAll('th').filter((th) =>
        !th.classes().includes('cursor-pointer') && th.text().includes('Descripción')
      );
      expect(nonClickable.length).toBeGreaterThan(0);
    }
  });

  it('renders row data from the API result', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Corte simple');
  });
});

describe('GenericTable for clients — no create button', () => {
  it('hides the create button when crud.create is false', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      data: [],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 0 },
    });

    const { pinia, router, i18n } = makePlugins('Admin');
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'clients' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    // Match the specific "Agregar Cliente" label, not bare "Agregar" — GenericFilters
    // also renders an "Agregar" button once a filter field is selected.
    expect(wrapper.text()).not.toContain('Agregar Cliente');
    expect(structure.tables.clients.crud?.create).toBe(false);
  });

  it('renders empty state when list returns zero rows', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      data: [],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 0 },
    });

    const { pinia, router, i18n } = makePlugins('Admin');
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'clients' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    const emptyComponent = wrapper.findComponent({ name: 'EmptyState' });
    const hasNoText = wrapper.text().includes('No hay');
    expect(emptyComponent.exists() || hasNoText).toBe(true);
  });
});

describe('GenericTable — sortable header toggles asc/desc and reloads', () => {
  it('clicking a sortable header sorts asc first, then desc on a second click', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockClear();
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ id: '1', name: 'Corte simple', description: null, default_duration_minutes: 30, default_price_ars: '500.00' }],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const nameHeader = wrapper.findAll('th').find((th) => th.text().includes('Nombre'));
    expect(nameHeader).toBeTruthy();

    await nameHeader!.trigger('click');
    await flushPromises();
    expect(listRows).toHaveBeenLastCalledWith('services', expect.objectContaining({ sort: 'name', dir: 'asc' }));
    expect(nameHeader!.text()).toContain('↑');

    await nameHeader!.trigger('click');
    await flushPromises();
    expect(listRows).toHaveBeenLastCalledWith('services', expect.objectContaining({ sort: 'name', dir: 'desc' }));
    expect(nameHeader!.text()).toContain('↓');
  });

  it('a non-sortable header click does not reload or set a sort field', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockClear();

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    const callsAfterInitialLoad = (listRows as ReturnType<typeof vi.fn>).mock.calls.length;

    const cols = structure.tables.services.columns as Record<string, ColumnDef>;
    if (!cols.description?.sortable) {
      const descHeader = wrapper.findAll('th').find((th) => th.text().includes('Descripción'));
      await descHeader!.trigger('click');
      await flushPromises();
      expect((listRows as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterInitialLoad);
    }
  });
});

describe('GenericTable — loading skeleton', () => {
  it('shows the row skeleton while the list request is in flight, then the rows once resolved', async () => {
    const { listRows } = await import('@/api/crud');
    let resolveFetch!: (value: Awaited<ReturnType<typeof listRows>>) => void;
    (listRows as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.findComponent(Skeleton).exists()).toBe(true);
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);

    resolveFetch({
      ok: true,
      data: [{ id: '1', name: 'Corte simple', description: null, default_duration_minutes: 30, default_price_ars: '500.00' }],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    });
    await flushPromises();

    expect(wrapper.findComponent(Skeleton).exists()).toBe(false);
    expect(wrapper.text()).toContain('Corte simple');
  });
});

describe('GenericTable — empty state also masks a load error', () => {
  it('a failed list request renders the same empty state as a genuinely empty table, not an error UI', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      code: 'internal',
      message: 'boom',
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // loadError is set internally but the template never branches on it — rows.length === 0
    // always renders the plain "no items" EmptyState, whether the list was empty or the fetch failed.
    expect(wrapper.findComponent({ name: 'EmptyState' }).exists()).toBe(true);
    expect(wrapper.text()).not.toMatch(/error|falló|fall[oó]/i);
  });
});

describe('GenericTable — FK cell shows the referenced label, or #id when unresolved', () => {
  beforeEach(() => {
    resetFkOptionsCache();
  });

  it('resolves a known FK id to its label and falls back to #id for one the options list does not contain', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockImplementation(async (table: string) => {
      if (table === 'professional_services') {
        return {
          ok: true,
          data: [
            { id: '1', professional_user_id: '7', service_id: '9', min_booking_days: null, max_booking_days: null },
            { id: '2', professional_user_id: '999', service_id: '9', min_booking_days: null, max_booking_days: null },
          ],
          meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 2 },
        };
      }
      if (table === 'professionals') {
        return { ok: true, data: [{ id: '7', display_name: 'Dra. Cascada' }] };
      }
      if (table === 'services') {
        return { ok: true, data: [{ id: '9', name: 'Corte Cascada' }] };
      }
      return { ok: true, data: [] };
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'professional_services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain('Dra. Cascada');
    expect(wrapper.text()).toContain('#999');
  });
});

describe('GenericTable — role-gated Edit action', () => {
  it('a role with update rights sees the row Editar action and the Acciones column', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ id: '1', display_name: 'Dra. Ana', bio: null }],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    });

    const { pinia, router, i18n } = makePlugins('Receptionist');
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'professionals' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain(es.actions.edit);
    expect(wrapper.findAll('th').some((th) => th.text().includes(es.generic.actionsColumn))).toBe(true);
  });

  it('a role without update rights (roleRequired.update excludes it) sees no Editar action or Acciones column', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ id: '1', display_name: 'Dra. Ana', bio: null }],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    });

    expect(structure.tables.professionals.roleRequired?.update).not.toContain('Client');

    const { pinia, router, i18n } = makePlugins('Client');
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'professionals' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain(es.actions.edit);
    expect(wrapper.findAll('th').some((th) => th.text().includes(es.generic.actionsColumn))).toBe(false);
  });
});

describe('GenericTable — create button requires the descriptor role, not just crud.create', () => {
  it('services.crud.create is true but roleRequired.create is Admin-only — a Professional does not see the add button', async () => {
    expect(structure.tables.services.crud?.create).toBe(true);
    expect(structure.tables.services.roleRequired?.create).toEqual(['Admin']);

    const { pinia, router, i18n } = makePlugins('Professional');
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain(structure.tables.services.addButtonLabel!.es);
  });
});

// Regression coverage for the pagination-mismatch defect: GenericTable used to hardcode its own
// `limit` (20) for Pagination's totalPages math while never sending a `limit` param, so the server's
// real page size (LIST_DEFAULT_LIMIT, currently 50) silently won page 2+ — a total that wasn't a
// multiple of the LOCAL 20 produced a phantom enabled "Siguiente" the server could never fill.
describe('GenericTable — pagination limit is derived from meta, not a hardcoded local value', () => {
  function serviceRow(id: number) {
    return { id: String(id), name: `Servicio ${id}`, description: null, default_duration_minutes: 30, default_price_ars: '500.00' };
  }

  it('a total that is not a multiple of the old hardcoded local limit (20) shows no phantom Next once the real server limit (50) fits it on one page', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [serviceRow(1)],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 33 },
    });

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    // Bug reproduction: with limit hardcoded to 20, totalPages = ceil(33/20) = 2 and Next would be
    // enabled here, even though the server (limit 50) already returned everything there is.
    const nextBtn = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    expect(nextBtn).toBeTruthy();
    expect(nextBtn!.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain(`${es.generic.page} 1 ${es.generic.of} 1`);
  });

  it('total not a multiple of the page size — navigating to the last page renders the partial page, not an empty one', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => ({
        ok: true,
        data: Array.from({ length: 20 }, (_, i) => serviceRow(i + 1)),
        meta: { page: 1, limit: 20, total: 33 },
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        data: Array.from({ length: 13 }, (_, i) => serviceRow(i + 21)),
        meta: { page: 2, limit: 20, total: 33 },
      }));

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    expect(wrapper.findAll('tr.virtualized-row').length).toBe(20);
    const nextBtn = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    expect(nextBtn!.attributes('disabled')).toBeUndefined();

    await nextBtn!.trigger('click');
    await flushPromises();

    // The partial last page (13 rows, not 20 and not 0) renders — the server was never asked for
    // more than it has, because the widget's limit came from meta, matching the server's own math.
    expect(wrapper.findAll('tr.virtualized-row').length).toBe(13);
    const prevBtn = wrapper.findAll('button').find((b) => b.text() === es.generic.previous);
    const nextBtnAfter = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    expect(prevBtn!.attributes('disabled')).toBeUndefined();
    expect(nextBtnAfter!.attributes('disabled')).toBeDefined();
  });

  it('an empty page beyond the last one still renders Pagination, so Previous stays reachable', async () => {
    const { listRows } = await import('@/api/crud');
    (listRows as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => ({
        ok: true,
        data: [serviceRow(1)],
        meta: { page: 1, limit: 20, total: 33 },
      }))
      .mockImplementationOnce(async () => ({
        // Simulates a page fetched past the data (e.g. total shrank between requests) — the old
        // `v-if="rows.length > 0"` guard hid the whole Pagination control here, stranding the user.
        ok: true,
        data: [],
        meta: { page: 2, limit: 20, total: 33 },
      }));

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const nextBtn = wrapper.findAll('button').find((b) => b.text() === es.generic.next);
    await nextBtn!.trigger('click');
    await flushPromises();

    const prevBtn = wrapper.findAll('button').find((b) => b.text() === es.generic.previous);
    expect(prevBtn).toBeTruthy();
    expect(prevBtn!.attributes('disabled')).toBeUndefined();
  });
});
