import { ref, watch, onScopeDispose } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Ref } from 'vue';
import type { LocationQuery, LocationQueryRaw, LocationQueryValue } from 'vue-router';
import {
  LIST_MAX_LIMIT,
  LIST_MAX_PAGE,
  INCLUDE_UNRELATED_PARAM,
  INCLUDE_UNRELATED_VALUE,
  isFilterParam,
  isReservedListParam,
  listParamEntries,
  stripFilterPrefix,
} from '@shared/ssot/list-protocol';

// Keeps list state (filters, sort, page) in the address bar so a view can be bookmarked, shared
// and restored on reload. The URL speaks the same vocabulary as the API request — both are
// produced by listParamEntries — so what a user copies is what the server was asked.

export interface ListQuerySyncOptions {
  // Re-fetch. Called whenever committed state changes, never during hydration.
  onChange: () => void;
  // Accepted vocabulary for this list. A hand-edited URL naming anything else is ignored rather
  // than forwarded to the server.
  sortableFields?: () => readonly string[];
  filterableFields?: () => readonly string[];
  // Filter keys that must always exist (so form inputs stay bound) even when absent from the URL.
  defaultFilters?: () => Record<string, string>;
  debounceMs?: number;
}

export interface ListQuerySync {
  page: Ref<number>;
  sort: Ref<string>;
  dir: Ref<'asc' | 'desc'>;
  limit: Ref<number | undefined>;
  filters: Ref<Record<string, string>>;
  // Waives the server's relevance narrowing for lists that apply one.
  includeUnrelated: Ref<boolean>;
  commit: () => void;
  commitDebounced: () => void;
  reset: () => void;
}

const DEFAULT_DEBOUNCE_MS = 250;

function firstValue(raw: LocationQueryValue | LocationQueryValue[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
}

function clampInt(raw: string, min: number, max: number): number | undefined {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, min), max);
}

function fingerprint(query: LocationQuery | LocationQueryRaw): string {
  return Object.entries(query)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : (value ?? '')}`)
    .sort()
    .join('&');
}

export function useListQuerySync(options: ListQuerySyncOptions): ListQuerySync {
  const route = useRoute();
  const router = useRouter();
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const page = ref(1);
  const sort = ref('');
  const dir = ref<'asc' | 'desc'>('asc');
  const limit = ref<number | undefined>(undefined);
  const filters = ref<Record<string, string>>({});
  const includeUnrelated = ref(false);

  let lastWritten = '';

  function accepts(allowed: (() => readonly string[]) | undefined, field: string): boolean {
    return allowed ? allowed().includes(field) : true;
  }

  function hydrate() {
    const query = route.query;

    // Clamped to the server's own bounds: a hand-edited page/limit asks for something the
    // server would have clamped anyway, so the view and the response stay in agreement.
    page.value = clampInt(firstValue(query.page), 1, LIST_MAX_PAGE) ?? 1;
    limit.value = clampInt(firstValue(query.limit), 1, LIST_MAX_LIMIT);
    dir.value = firstValue(query.dir) === 'desc' ? 'desc' : 'asc';
    includeUnrelated.value = firstValue(query[INCLUDE_UNRELATED_PARAM]) === INCLUDE_UNRELATED_VALUE;

    const requestedSort = firstValue(query.sort);
    sort.value = accepts(options.sortableFields, requestedSort) ? requestedSort : '';

    const next: Record<string, string> = { ...(options.defaultFilters?.() ?? {}) };
    for (const [key, raw] of Object.entries(query)) {
      if (!isFilterParam(key)) continue;
      const field = stripFilterPrefix(key);
      if (!accepts(options.filterableFields, field)) continue;
      const value = firstValue(raw);
      if (value !== '') next[field] = value;
    }
    filters.value = next;

    lastWritten = fingerprint(query);
  }

  function queryFromState(): LocationQueryRaw {
    const next: LocationQueryRaw = {};

    // Query keys this list doesn't own belong to whoever put them there.
    for (const [key, value] of Object.entries(route.query)) {
      if (!isReservedListParam(key) && !isFilterParam(key)) next[key] = value;
    }

    const params = listParamEntries({
      page: page.value,
      limit: limit.value,
      sort: sort.value || undefined,
      dir: sort.value ? dir.value : undefined,
      filters: filters.value,
      includeUnrelated: includeUnrelated.value,
    });
    for (const [key, value] of params) next[key] = value;

    return next;
  }

  // replace, never push: one history entry per view, not one per keystroke.
  function writeUrl() {
    const next = queryFromState();
    const written = fingerprint(next);
    if (written === fingerprint(route.query)) return;
    lastWritten = written;
    void router.replace({ query: next }).catch(() => undefined);
  }

  let pending: ReturnType<typeof setTimeout> | undefined;

  function cancelPending() {
    if (pending === undefined) return;
    clearTimeout(pending);
    pending = undefined;
  }

  function commit() {
    cancelPending();
    writeUrl();
    options.onChange();
  }

  function commitDebounced() {
    cancelPending();
    pending = setTimeout(() => {
      pending = undefined;
      commit();
    }, debounceMs);
  }

  // Switching to another list drops the previous one's state entirely — its filters must not
  // survive in the URL and be replayed against a table that has no such columns.
  function reset() {
    cancelPending();
    page.value = 1;
    sort.value = '';
    dir.value = 'asc';
    limit.value = undefined;
    includeUnrelated.value = false;
    filters.value = { ...(options.defaultFilters?.() ?? {}) };
    writeUrl();
  }

  hydrate();

  // Back/forward restores the earlier view rather than leaving stale rows on screen.
  watch(
    () => route.query,
    (query) => {
      if (fingerprint(query) === lastWritten) return;
      hydrate();
      options.onChange();
    },
  );

  onScopeDispose(cancelPending);

  return { page, sort, dir, limit, filters, includeUnrelated, commit, commitDebounced, reset };
}
