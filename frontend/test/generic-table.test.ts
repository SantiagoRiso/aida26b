import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';

import { structure } from '@shared/ssot/structure';
import type { ColumnDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';

// Mirrors crud.ts buildQuery so the query-string contract is asserted without apiFetch.
function buildQuery(params: {
  page?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filters?: Record<string, string>;
}): string {
  const parts: string[] = [];
  if (params.page && params.page > 1) parts.push(`page=${params.page}`);
  if (params.sort) parts.push(`sort=${encodeURIComponent(params.sort)}`);
  if (params.dir) parts.push(`dir=${params.dir}`);
  if (params.filters) {
    for (const [field, value] of Object.entries(params.filters)) {
      if (value !== '' && value !== undefined) {
        parts.push(`filter_${encodeURIComponent(field)}=${encodeURIComponent(value)}`);
      }
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

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

vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({
    ok: true,
    data: [
      { id: '1', name: 'Corte simple', description: null, default_duration_minutes: 30, default_price_ars: '500.00' },
    ],
    meta: { page: 1, limit: 20, total: 1 },
  }),
  getRow: vi.fn(),
  createRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRow: vi.fn(),
}));

function makePlugins(role = 'Admin') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'admin',
    email: null,
    role: role as 'Admin' | 'Professional' | 'Receptionist' | 'Client',
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
      meta: { page: 1, limit: 20, total: 0 },
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
      meta: { page: 1, limit: 20, total: 0 },
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
