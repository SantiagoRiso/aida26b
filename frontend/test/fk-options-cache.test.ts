import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { listRows } from '@/api/crud';
import {
  useForeignKeyOptions,
  invalidateFkOptions,
  resetFkOptionsCache,
  FK_OPTIONS_LIMIT,
  FK_SEARCH_LIMIT,
  FK_SEARCH_DEBOUNCE_MS,
} from '@/composables/useForeignKeyOptions';
import type { ForeignKeyDef } from '@shared/types/types';

vi.mock('@/api/crud', () => ({ listRows: vi.fn() }));

const mockedListRows = listRows as ReturnType<typeof vi.fn>;

const professionalsFk: ForeignKeyDef = { table: 'professionals', valueField: 'id', labelField: 'display_name' };

const rows = [
  { id: '1', display_name: 'Dr. Ana', dni: '111' },
  { id: '2', display_name: 'Dr. Bruno', dni: null },
];

beforeEach(() => {
  resetFkOptionsCache();
  mockedListRows.mockReset();
  mockedListRows.mockResolvedValue({ ok: true, data: rows });
});

describe('useForeignKeyOptions — shared cache', () => {
  it('serves every consumer of the same table from one fetch at the server cap', async () => {
    const a = useForeignKeyOptions(professionalsFk);
    const b = useForeignKeyOptions(professionalsFk);
    await flushPromises();

    expect(mockedListRows).toHaveBeenCalledTimes(1);
    // Waived relevance: an option list resolves ids to names, so it must cover every row the
    // viewer may read, not just the ones a list screen would consider relevant to them.
    expect(mockedListRows).toHaveBeenCalledWith('professionals', { limit: 500, includeUnrelated: true });
    expect(FK_OPTIONS_LIMIT).toBe(500);
    // Both consumers share the same reactive options.
    expect(a.labelFor('1')).toBe('Dr. Ana');
    expect(b.labelFor(2)).toBe('Dr. Bruno');
  });

  it('derives different label fields from one shared table fetch', async () => {
    const names = useForeignKeyOptions(professionalsFk);
    const dnis = useForeignKeyOptions({ ...professionalsFk, labelField: 'dni' });
    await flushPromises();

    expect(mockedListRows).toHaveBeenCalledTimes(1);
    expect(names.labelFor('2')).toBe('Dr. Bruno');
    expect(dnis.labelFor('1')).toBe('111');
    // A null label maps to '' so callers can pick their own fallback (GenericTable shows #id).
    expect(dnis.labelFor('2')).toBe('');
  });

  it('resolves labels for consumers created before the fetch finishes', async () => {
    let resolveFetch!: (v: { ok: boolean; data: typeof rows }) => void;
    mockedListRows.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));

    const { labelFor, loading } = useForeignKeyOptions(professionalsFk);
    expect(labelFor('1')).toBeNull();
    expect(loading.value).toBe(true);

    resolveFetch({ ok: true, data: rows });
    await flushPromises();
    expect(labelFor('1')).toBe('Dr. Ana');
    expect(loading.value).toBe(false);
  });

  it('invalidateFkOptions refetches only that table and updates live consumers', async () => {
    const pro = useForeignKeyOptions(professionalsFk);
    await flushPromises();
    expect(pro.labelFor('1')).toBe('Dr. Ana');

    mockedListRows.mockResolvedValue({ ok: true, data: [{ id: '1', display_name: 'Dra. Ana Pérez' }] });
    invalidateFkOptions('services');
    await flushPromises();
    expect(mockedListRows).toHaveBeenCalledTimes(1);
    expect(pro.labelFor('1')).toBe('Dr. Ana');

    invalidateFkOptions('professionals');
    await flushPromises();
    expect(mockedListRows).toHaveBeenCalledTimes(2);
    expect(pro.labelFor('1')).toBe('Dra. Ana Pérez');
  });

  it('a failed load yields empty options, not stale or throwing lookups', async () => {
    mockedListRows.mockResolvedValueOnce({ ok: false });
    const { options, labelFor } = useForeignKeyOptions(professionalsFk);
    await flushPromises();
    expect(options.value).toEqual([]);
    expect(labelFor('1')).toBeNull();
  });
});

describe('useForeignKeyOptions — server-side search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Draining a debounced search: advance past the wait, then let the request's promise settle.
  async function settleSearch() {
    await vi.advanceTimersByTimeAsync(FK_SEARCH_DEBOUNCE_MS);
    await flushPromises();
  }

  it('does not fire a request per keystroke', async () => {
    const { search } = useForeignKeyOptions(professionalsFk);
    await flushPromises();
    // The first page only.
    expect(mockedListRows).toHaveBeenCalledTimes(1);

    for (const term of ['z', 'za', 'zar', 'zara']) search(term);
    // Still nothing: the burst has not settled.
    await vi.advanceTimersByTimeAsync(FK_SEARCH_DEBOUNCE_MS - 1);
    expect(mockedListRows).toHaveBeenCalledTimes(1);

    await settleSearch();
    expect(mockedListRows).toHaveBeenCalledTimes(2);
    expect(mockedListRows).toHaveBeenLastCalledWith('professionals', {
      filters: { display_name: 'zara' },
      limit: FK_SEARCH_LIMIT,
      includeUnrelated: true,
    });
  });

  it('reaches a value the first page never carried, and keeps it selectable afterwards', async () => {
    // The roster is capped: this professional sits past the first page.
    const { options, labelFor, search } = useForeignKeyOptions(professionalsFk);
    await flushPromises();
    expect(labelFor('999')).toBeNull();

    mockedListRows.mockResolvedValue({ ok: true, data: [{ id: '999', display_name: 'Dra. Zaráte', dni: '999' }] });
    search('zar');
    await settleSearch();

    expect(options.value).toContainEqual({ value: '999', label: 'Dra. Zaráte' });
    // A match joins the known rows rather than replacing them: clearing the query must not
    // strand the value that was just chosen.
    search('');
    await settleSearch();
    expect(labelFor('999')).toBe('Dra. Zaráte');
    expect(labelFor('1')).toBe('Dr. Ana');
  });

  it('a blank query asks the server nothing', async () => {
    const { search } = useForeignKeyOptions(professionalsFk);
    await flushPromises();
    mockedListRows.mockClear();

    search('   ');
    await settleSearch();
    expect(mockedListRows).not.toHaveBeenCalled();
  });

  it('a slow earlier query cannot overwrite the newest one', async () => {
    const { options, search } = useForeignKeyOptions(professionalsFk);
    await flushPromises();

    let resolveSlow!: (v: { ok: boolean; data: Array<Record<string, string>> }) => void;
    mockedListRows.mockReturnValueOnce(new Promise((r) => { resolveSlow = r; }));
    search('slow');
    await vi.advanceTimersByTimeAsync(FK_SEARCH_DEBOUNCE_MS);

    mockedListRows.mockResolvedValue({ ok: true, data: [{ id: '42', display_name: 'Dr. Rápido' }] });
    search('fast');
    await settleSearch();

    resolveSlow({ ok: true, data: [{ id: '77', display_name: 'Dr. Lento' }] });
    await flushPromises();

    expect(options.value).toContainEqual({ value: '42', label: 'Dr. Rápido' });
    expect(options.value.some((o) => o.value === '77')).toBe(false);
  });

  it('searches the column the caller names, not always the label', async () => {
    const { search } = useForeignKeyOptions(professionalsFk, {
      searchField: (term) => (/^\d+$/.test(term) ? 'dni' : 'display_name'),
    });
    await flushPromises();

    search('30123456');
    await settleSearch();
    expect(mockedListRows).toHaveBeenLastCalledWith('professionals', {
      filters: { dni: '30123456' },
      limit: FK_SEARCH_LIMIT,
      includeUnrelated: true,
    });
  });
});
