import { ref, computed } from 'vue';
import type { Ref } from 'vue';
import { listRows } from '@/api/crud';
import { debounce } from '@/composables/debounce';
import type { ForeignKeyDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import { isTableKey } from '@shared/utils/utils';

export interface SelectOption {
  value: string;
  label: string;
}

// A foreign-key cell value: the referenced row's pk as the wire carries it, or absent when the
// column is null / the row has not loaded.
export type ForeignKeyValue = string | number | null | undefined;

// First page of a referenced table: enough to resolve the labels of what is already on screen
// and to fill a dropdown, never a guarantee of completeness.
export const FK_OPTIONS_LIMIT = 500;

// A typed query answers with matches, not with a roster, so it needs a far smaller page than
// the unfiltered first page.
export const FK_SEARCH_LIMIT = 50;

export const FK_SEARCH_DEBOUNCE_MS = 250;

interface FkTableEntry {
  rows: Ref<ReadonlyArray<object>>;
  loading: Ref<boolean>;
  reload: () => Promise<void>;
  merge: (extra: ReadonlyArray<object>, valueField: string) => void;
}

const cache = new Map<string, FkTableEntry>();

function toOptions(rows: ReadonlyArray<object>, fk: ForeignKeyDef): SelectOption[] {
  return rows.map((row) => {
    return {
      value: String(Reflect.get(row, fk.valueField) ?? ''),
      label: String(Reflect.get(row, fk.labelField) ?? ''),
    };
  });
}

function makeLabelFor(options: Ref<SelectOption[]>) {
  const optionMap = computed(() => {
    const m = new Map<string, string>();
    for (const o of options.value) m.set(o.value, o.label);
    return m;
  });
  // Resolve an id to its display label — the id→name lookup every consumer needs, so no screen
  // has to rebuild it. Returns null for a missing/unknown id so callers can pick their own fallback.
  return (id: ForeignKeyValue) => {
    if (id == null) return null;
    return optionMap.value.get(String(id)) ?? null;
  };
}

function acquire(table: TableKey): FkTableEntry {
  let entry = cache.get(table);
  if (!entry) {
    const rows = ref<ReadonlyArray<object>>([]);
    const loading = ref(false);
    const reload = async () => {
      loading.value = true;
      try {
        // An id must resolve to a name whatever the viewer's relevance narrowing would hide,
        // or a referenced row renders blank. Permission scoping still applies.
        const result = await listRows(table, { limit: FK_OPTIONS_LIMIT, includeUnrelated: true });
        rows.value = result.ok ? result.data : [];
      } finally {
        loading.value = false;
      }
    };
    // Rows found by a search join the known set instead of replacing it: a value picked from a
    // query must keep resolving to its name once the query is cleared.
    const merge = (extra: ReadonlyArray<object>, valueField: string) => {
      if (extra.length === 0) return;
      const byValue = new Map<string, object>();
      for (const row of rows.value) byValue.set(String(Reflect.get(row, valueField) ?? ''), row);
      for (const row of extra) byValue.set(String(Reflect.get(row, valueField) ?? ''), row);
      rows.value = [...byValue.values()];
    };
    entry = { rows, loading, reload, merge };
    cache.set(table, entry);
    void entry.reload();
  }
  return entry;
}

// After a write to a referenced table, refetch its cached options so live
// consumers don't keep showing pre-edit labels.
export function invalidateFkOptions(table: string): void {
  void cache.get(table)?.reload();
}

export function resetFkOptionsCache(): void {
  cache.clear();
}

export interface FkOptionsConfig {
  // Which column a typed query is matched against, decided per query. Defaults to the label
  // field; a roster searchable by document number picks the column from the shape of the text.
  searchField?: (term: string) => string;
}

export function useForeignKeyOptions(fk: ForeignKeyDef, config: FkOptionsConfig = {}) {
  if (!isTableKey(fk.table)) throw new Error(`Unknown foreign-key table '${fk.table}'`);
  const table = fk.table;
  const entry = acquire(table);
  const options = computed(() => toOptions(entry.rows.value, fk));

  const searching = ref(false);
  const searchField = config.searchField ?? (() => fk.labelField);
  // Only the newest query may publish: a slow earlier request must not overwrite it.
  let currentQuery = 0;

  async function runSearch(term: string): Promise<void> {
    const q = term.trim();
    if (q === '') {
      searching.value = false;
      return;
    }
    const mine = ++currentQuery;
    searching.value = true;
    try {
      const result = await listRows(table, {
        filters: { [searchField(q)]: q },
        limit: FK_SEARCH_LIMIT,
        includeUnrelated: true,
      });
      if (mine !== currentQuery) return;
      if (result.ok) entry.merge(result.data, fk.valueField);
    } finally {
      if (mine === currentQuery) searching.value = false;
    }
  }

  // The option set is a query result, not the first page cut short: what the viewer types goes
  // to the server, so a value beyond the first page is still reachable.
  const search = debounce((term: string) => { void runSearch(term); }, FK_SEARCH_DEBOUNCE_MS);

  const loading = computed(() => entry.loading.value || searching.value);

  return { options, loading, labelFor: makeLabelFor(options), search };
}
