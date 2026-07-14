import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { listRows } from '@/api/crud';
import {
  useForeignKeyOptions,
  invalidateFkOptions,
  resetFkOptionsCache,
  FK_OPTIONS_LIMIT,
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
  it('serves every consumer of the same table+fields from one fetch at the server cap', async () => {
    const a = useForeignKeyOptions(professionalsFk);
    const b = useForeignKeyOptions(professionalsFk);
    await flushPromises();

    expect(mockedListRows).toHaveBeenCalledTimes(1);
    expect(mockedListRows).toHaveBeenCalledWith('professionals', { limit: 500 });
    expect(FK_OPTIONS_LIMIT).toBe(500);
    // Both consumers share the same reactive options.
    expect(a.labelFor('1')).toBe('Dr. Ana');
    expect(b.labelFor(2)).toBe('Dr. Bruno');
  });

  it('treats a different labelField as a distinct entry (separate fetch, own labels)', async () => {
    const names = useForeignKeyOptions(professionalsFk);
    const dnis = useForeignKeyOptions({ ...professionalsFk, labelField: 'dni' });
    await flushPromises();

    expect(mockedListRows).toHaveBeenCalledTimes(2);
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

describe('useForeignKeyOptions — dependsOn (filtered, uncached)', () => {
  const servicesFk: ForeignKeyDef = {
    table: 'services',
    valueField: 'id',
    labelField: 'name',
    dependsOn: { field: 'professional_user_id', foreignField: 'professional_user_id' },
  };

  it('fetches only once a parent value exists, filtered by it', async () => {
    const parent = ref<string | undefined>(undefined);
    const { options } = useForeignKeyOptions(servicesFk, () => parent.value);
    await flushPromises();
    expect(mockedListRows).not.toHaveBeenCalled();
    expect(options.value).toEqual([]);

    mockedListRows.mockResolvedValue({ ok: true, data: [{ id: 's1', name: 'Corte' }] });
    parent.value = '7';
    await nextTick();
    await flushPromises();
    expect(mockedListRows).toHaveBeenCalledWith('services', {
      filters: { professional_user_id: '7' },
      limit: 500,
    });
    expect(options.value).toEqual([{ value: 's1', label: 'Corte' }]);
  });

  it('is never served from the shared cache', async () => {
    mockedListRows.mockResolvedValue({ ok: true, data: [{ id: 's1', name: 'Corte' }] });
    const parent = ref<string | undefined>('7');
    useForeignKeyOptions(servicesFk, () => parent.value);
    useForeignKeyOptions(servicesFk, () => parent.value);
    await flushPromises();
    expect(mockedListRows).toHaveBeenCalledTimes(2);
  });
});
