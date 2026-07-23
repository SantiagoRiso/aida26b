import { ref, computed } from 'vue';
import type { Ref } from 'vue';
import { listRows } from '@/api/crud';
import { debounce } from '@/composables/debounce';
import type { ForeignKeyDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import { isTableKey, getPkFields } from '@shared/utils/utils';
import { encodeFilterSet, LIST_MAX_FILTER_SET } from '@shared/ssot/list-protocol';

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

// Missing ids are asked for as one set filter per chunk; the chunk is the server's cap on a set,
// so the two can't drift into a request the server answers with nothing.
export const FK_RESOLVE_CHUNK = LIST_MAX_FILTER_SET;

interface FkTableEntry {
  rows: Ref<ReadonlyArray<object>>;
  loading: Ref<boolean>;
  unresolved: Ref<ReadonlySet<string>>;
  reload: () => Promise<void>;
  merge: (extra: ReadonlyArray<object>, valueField: string) => void;
  request: (id: string, valueField: string) => void;
  // Detach the entry from any still-pending resolve: a queued flush references this entry's
  // closure, so dropping it from the cache alone would still let a late microtask fetch and
  // mutate. Once disposed the entry stops scheduling and stops touching reactive state.
  dispose: () => void;
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

function makeLabelFor(
  options: Ref<SelectOption[]>,
  onMiss: (id: string) => void,
) {
  const optionMap = computed(() => {
    const m = new Map<string, string>();
    for (const o of options.value) m.set(o.value, o.label);
    return m;
  });
  // Resolve an id to its display label — the id→name lookup every consumer needs, so no screen
  // has to rebuild it. Returns null for a missing/unknown id so callers can pick their own fallback.
  return (id: ForeignKeyValue) => {
    if (id == null) return null;
    const key = String(id);
    const label = optionMap.value.get(key);
    if (label !== undefined) return label;
    // Asking for a label the first page never carried is what tells us the row is worth fetching.
    onMiss(key);
    return null;
  };
}

function acquire(table: TableKey): FkTableEntry {
  const existing = cache.get(table);
  if (existing) return existing;

  const rows = ref<ReadonlyArray<object>>([]);
  const loading = ref(false);
  const unresolved = ref<ReadonlySet<string>>(new Set());

  // Rows found by a search or by an id lookup join the known set instead of replacing it: a
  // value picked from a query must keep resolving to its name once the query is cleared.
  const merge = (extra: ReadonlyArray<object>, valueField: string) => {
    if (extra.length === 0) return;
    const byValue = new Map<string, object>();
    for (const row of rows.value) byValue.set(String(Reflect.get(row, valueField) ?? ''), row);
    for (const row of extra) byValue.set(String(Reflect.get(row, valueField) ?? ''), row);
    rows.value = [...byValue.values()];
  };

  let loadPromise: Promise<void> | null = null;
  // Every id ever asked for, so a reference the server will not hand back is fetched once and
  // never again: a dangling or out-of-scope target would otherwise be retried on every render.
  const asked = new Set<string>();
  const queued = new Set<string>();
  let scheduled = false;
  let keyField = 'id';
  let disposed = false;

  const reload = async () => {
    loading.value = true;
    // A refetch is the retry hook for references that were unreadable before.
    asked.clear();
    unresolved.value = new Set();
    loadPromise = (async () => {
      try {
        // An id must resolve to a name whatever the viewer's relevance narrowing would hide,
        // or a referenced row renders blank. Permission scoping still applies.
        const result = await listRows(table, { limit: FK_OPTIONS_LIMIT, includeUnrelated: true });
        rows.value = result.ok ? result.data : [];
      } finally {
        loading.value = false;
      }
    })();
    await loadPromise;
  };

  function markUnresolved(ids: string[]) {
    if (ids.length === 0) return;
    const next = new Set(unresolved.value);
    for (const id of ids) next.add(id);
    unresolved.value = next;
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    // The first page may already answer these; waiting for it avoids a burst of redundant reads.
    await loadPromise;
    if (disposed) return;
    const known = new Set(rows.value.map((row) => String(Reflect.get(row, keyField) ?? '')));
    const ids = [...queued].filter((id) => !known.has(id));
    queued.clear();

    for (let i = 0; i < ids.length; i += FK_RESOLVE_CHUNK) {
      const chunk = ids.slice(i, i + FK_RESOLVE_CHUNK);
      const result = await listRows(table, {
        filters: { [keyField]: encodeFilterSet(chunk) },
        limit: chunk.length,
        includeUnrelated: true,
      });

      if (!result.ok) {
        markUnresolved(chunk);
        continue;
      }

      const found = result.data;
      merge(found, keyField);
      const resolved = new Set(found.map((row) => String(Reflect.get(row, keyField) ?? '')));
      // Whatever the set query did not answer with is dangling, archived or another tenant's.
      markUnresolved(chunk.filter((id) => !resolved.has(id)));
    }
  }

  const request = (id: string, valueField: string) => {
    if (disposed || id === '' || asked.has(id)) return;
    asked.add(id);
    queued.add(id);
    keyField = valueField;
    if (scheduled) return;
    // One render pass worth of cells batches into a single round of lookups.
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed) return;
      void flush();
    });
  };

  const dispose = () => { disposed = true; };

  const entry: FkTableEntry = { rows, loading, unresolved, reload, merge, request, dispose };
  cache.set(table, entry);
  void entry.reload();
  return entry;
}

// After a write to a referenced table, refetch its cached options so live
// consumers don't keep showing pre-edit labels.
export function invalidateFkOptions(table: string): void {
  void cache.get(table)?.reload();
}

// Test seam only: drop every cached table AND detach any resolve still pending on it, so a
// queued flush from a prior test cannot fetch or mutate reactive state once the next test runs.
export function resetFkOptionsCache(): void {
  for (const entry of cache.values()) entry.dispose();
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

  // Single-row reads address the row by its primary key; a value field that is not the pk has
  // no by-id endpoint, so those references stay first-page-only.
  const pkFields = getPkFields(table);
  const resolvableById = pkFields.length === 1 && pkFields[0] === fk.valueField;

  // Fetch a referenced row the first page did not carry. Idempotent and safe to call from a
  // render: it queues, and only the eventual response touches reactive state.
  function resolve(id: ForeignKeyValue): void {
    if (id == null || !resolvableById) return;
    entry.request(String(id), fk.valueField);
  }

  // True once the server has declined to hand the row over: dangling, archived, or another
  // tenant's. Callers show a neutral fallback rather than a blank or a bare id.
  function isUnresolved(id: ForeignKeyValue): boolean {
    return id != null && entry.unresolved.value.has(String(id));
  }

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

  const labelFor = makeLabelFor(options, (id) => {
    if (resolvableById) entry.request(id, fk.valueField);
  });

  return { options, loading, labelFor, search, resolve, isUnresolved };
}
