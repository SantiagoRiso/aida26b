import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { listRows } from '@/api/crud';
import type { ListParams } from '@/api/crud';
import {
  useForeignKeyOptions,
  resetFkOptionsCache,
  invalidateFkOptions,
  FK_RESOLVE_CHUNK,
} from '@/composables/useForeignKeyOptions';
import { parseFilterSet } from '@shared/ssot/list-protocol';
import type { ForeignKeyDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
// Imported statically (not `await import` inside a test) so the heavy .vue transform happens at file
// load, not against a per-test timeout — the transform can outrun 5s on a slow/loaded machine.
import GenericTable from '@/components/generic/GenericTable.vue';
import ForeignKeySelect from '@/components/shared/ForeignKeySelect.vue';

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

const mockedListRows = listRows as ReturnType<typeof vi.fn>;

const clientsFk: ForeignKeyDef = { table: 'clients', valueField: 'id', labelField: 'display_name' };

// The cached page holds the oldest rows; anything the seed below does not list stands for a row
// past the cap — exactly the newest clients, the ones with upcoming activity.
const firstPage = [
  { id: '1', display_name: 'Ana Vieja', dni: '111' },
  { id: '2', display_name: 'Bruno Viejo', dni: '222' },
];

// Rows the roster does not carry but a by-id query would find.
let beyondFirstPage: Record<string, object>;
let rosterPage: ReadonlyArray<object>;

// The ids each resolve request asked for, in order — one entry per request issued.
let requestedSets: string[][];

function idFilterOf(params: ListParams | undefined): string | undefined {
  return params?.filters?.id;
}

function seedTable(rows: ReadonlyArray<object> = firstPage) {
  rosterPage = rows;
}

function fromServer(rows: ReadonlyArray<{ id: string; display_name: string }>) {
  for (const row of rows) beyondFirstPage[row.id] = row;
}

beforeEach(() => {
  resetFkOptionsCache();
  mockedListRows.mockReset();
  beyondFirstPage = {};
  requestedSets = [];
  seedTable();

  mockedListRows.mockImplementation((_table: TableKey, params?: ListParams) => {
    const set = idFilterOf(params);
    if (set === undefined) return Promise.resolve({ ok: true, data: rosterPage });

    const ids = parseFilterSet(set);
    requestedSets.push(ids);
    return Promise.resolve({
      ok: true,
      data: ids.map((id) => beyondFirstPage[id]).filter((row) => row !== undefined),
    });
  });
});

describe('useForeignKeyOptions — resolving a value past the cached page', () => {
  it('asks for the missing id as a filtered query and resolves its label', async () => {
    const { labelFor } = useForeignKeyOptions(clientsFk);
    await flushPromises();

    fromServer([{ id: '900', display_name: 'Zoe Nueva' }]);
    expect(labelFor('900')).toBeNull();
    await flushPromises();

    expect(requestedSets).toEqual([['900']]);
    expect(labelFor('900')).toBe('Zoe Nueva');
  });

  it('asks for a batch of ids in one request, once per distinct id', async () => {
    const { labelFor } = useForeignKeyOptions(clientsFk);
    await flushPromises();

    fromServer([
      { id: '900', display_name: 'Cliente 900' },
      { id: '901', display_name: 'Cliente 901' },
    ]);
    // A page of rows referencing two clients, repeatedly — the shape a real table cell renderer has.
    for (const id of ['900', '901', '900', '901', '900']) labelFor(id);
    await flushPromises();

    expect(requestedSets).toEqual([['900', '901']]);
    expect(labelFor('901')).toBe('Cliente 901');
  });

  it('splits a batch larger than the cap into one request per chunk', async () => {
    const { labelFor } = useForeignKeyOptions(clientsFk);
    await flushPromises();

    const ids = Array.from({ length: FK_RESOLVE_CHUNK * 2 + 1 }, (_, n) => String(1000 + n));
    fromServer(ids.map((id) => ({ id, display_name: `Cliente ${id}` })));
    for (const id of ids) labelFor(id);
    await flushPromises();

    expect(requestedSets).toHaveLength(3);
    expect(requestedSets.map((set) => set.length)).toEqual([FK_RESOLVE_CHUNK, FK_RESOLVE_CHUNK, 1]);
    expect(requestedSets.flat()).toEqual(ids);
    expect(labelFor(ids[ids.length - 1])).toBe(`Cliente ${ids[ids.length - 1]}`);
  });

  it('waits for the first page rather than fetching ids it already carries', async () => {
    let resolveList!: (v: { ok: boolean; data: typeof firstPage }) => void;
    mockedListRows.mockReturnValueOnce(new Promise((r) => { resolveList = r; }));

    const { labelFor } = useForeignKeyOptions(clientsFk);
    // Asked before the roster lands, so nothing is known yet.
    expect(labelFor('1')).toBeNull();

    resolveList({ ok: true, data: firstPage });
    await flushPromises();

    expect(requestedSets).toEqual([]);
    expect(labelFor('1')).toBe('Ana Vieja');
  });

  it('does not re-ask for a reference the server will not hand over', async () => {
    const { labelFor, isUnresolved } = useForeignKeyOptions(clientsFk);
    await flushPromises();

    expect(labelFor('404')).toBeNull();
    await flushPromises();
    expect(requestedSets).toHaveLength(1);
    expect(isUnresolved('404')).toBe(true);

    // Re-rendering the same cell must not turn a dangling or invisible target into a request loop.
    for (let i = 0; i < 5; i++) labelFor('404');
    await flushPromises();
    expect(requestedSets).toHaveLength(1);
  });

  it('marks only the members the answer left out', async () => {
    const { labelFor, isUnresolved } = useForeignKeyOptions(clientsFk);
    await flushPromises();

    fromServer([{ id: '900', display_name: 'Zoe Nueva' }]);
    labelFor('900');
    labelFor('404');
    await flushPromises();

    expect(requestedSets).toEqual([['900', '404']]);
    expect(isUnresolved('900')).toBe(false);
    expect(isUnresolved('404')).toBe(true);
    expect(labelFor('900')).toBe('Zoe Nueva');
  });

  it('gives an unreadable reference another chance after a refetch', async () => {
    const { labelFor, isUnresolved } = useForeignKeyOptions(clientsFk);
    await flushPromises();
    labelFor('900');
    await flushPromises();
    expect(isUnresolved('900')).toBe(true);

    fromServer([{ id: '900', display_name: 'Zoe Nueva' }]);
    invalidateFkOptions('clients');
    await flushPromises();

    expect(isUnresolved('900')).toBe(false);
    expect(labelFor('900')).toBeNull();
    await flushPromises();
    expect(labelFor('900')).toBe('Zoe Nueva');
  });

  it('leaves a search result alone instead of re-fetching what the query already merged', async () => {
    const { labelFor, options, search } = useForeignKeyOptions(clientsFk);
    await flushPromises();

    mockedListRows.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, data: [{ id: '900', display_name: 'Zoe Nueva' }] }),
    );
    search('zoe');
    await new Promise((r) => setTimeout(r, 300));
    await flushPromises();

    // Merged, not replaced: the first page is still resolvable alongside the match.
    expect(options.value).toContainEqual({ value: '900', label: 'Zoe Nueva' });
    expect(labelFor('1')).toBe('Ana Vieja');
    expect(labelFor('900')).toBe('Zoe Nueva');
    await flushPromises();
    expect(requestedSets).toEqual([]);
  });
});

function makePlugins() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'admin',
    email: null,
    role: 'Admin',
    business_id: null,
    is_active: true,
    must_change_password: false,
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return { pinia, router, i18n };
}

// The table under test lists rows referencing a client past the cached page.
function mountingListImpl(resolvable: ReadonlyArray<{ id: string; display_name: string }>) {
  return (table: TableKey, params?: ListParams) => {
    const set = idFilterOf(params);
    if (set !== undefined) {
      const ids = parseFilterSet(set);
      requestedSets.push(ids);
      return Promise.resolve({ ok: true, data: resolvable.filter((row) => ids.includes(row.id)) });
    }
    if (table === 'client_professional_services') {
      return Promise.resolve({
        ok: true,
        data: [{ id: '5', client_user_id: '900', professional_user_id: '1', service_id: '1', price_ars: '500.00' }],
        meta: { page: 1, limit: 50, total: 1 },
      });
    }
    if (table === 'clients') return Promise.resolve({ ok: true, data: firstPage });
    return Promise.resolve({ ok: true, data: [{ id: '1', name: 'Corte', display_name: 'Dr. Uno' }] });
  };
}

describe('GenericTable — a foreign-key cell past the cached page', () => {
  it('renders the referenced row label instead of a bare id', async () => {
    mockedListRows.mockImplementation(mountingListImpl([{ id: '900', display_name: 'Zoe Nueva' }]));

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'client_professional_services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    // Resolution is a multi-tick chain (load rows → render cell → miss → await first page → by-id
    // fetch → re-render); wait for the label rather than a fixed tick count that races under load.
    await vi.waitFor(() => {
      const cells = wrapper.findAll('tbody td').map((td) => td.text());
      expect(cells).toContain('Zoe Nueva');
    }, { timeout: 4000 });

    expect(requestedSets).toContainEqual(['900']);
    expect(wrapper.findAll('tbody td').map((td) => td.text())).not.toContain('#900');
  }, 15000);

  it('reads an unreadable reference as unavailable, not as an id', async () => {
    mockedListRows.mockImplementation(mountingListImpl([]));

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'client_professional_services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await vi.waitFor(() => {
      const cells = wrapper.findAll('tbody td').map((td) => td.text());
      expect(cells).toContain(es.generic.unresolvedReference);
    }, { timeout: 4000 });

    expect(wrapper.findAll('tbody td').map((td) => td.text())).not.toContain('#900');
  }, 15000);
});

describe('ForeignKeySelect — a bound value past the cached page', () => {
  it('shows the referenced label rather than an empty required field', async () => {
    fromServer([{ id: '900', display_name: 'Zoe Nueva' }]);

    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(ForeignKeySelect, {
      props: { foreignKey: clientsFk, modelValue: '900' },
      global: { plugins: [pinia, router, i18n] },
    });
    await vi.waitFor(() => {
      expect((wrapper.get('input').element as HTMLInputElement).value).toBe('Zoe Nueva');
    }, { timeout: 4000 });
    expect(requestedSets).toContainEqual(['900']);
  }, 15000);

  it('names an unreadable reference instead of looking like nothing is selected', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(ForeignKeySelect, {
      props: { foreignKey: clientsFk, modelValue: '900' },
      global: { plugins: [pinia, router, i18n] },
    });
    await vi.waitFor(() => {
      expect((wrapper.get('input').element as HTMLInputElement).value).toBe(es.generic.unresolvedReference);
    }, { timeout: 4000 });
  }, 15000);
});
