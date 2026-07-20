import { ref, computed, watch } from 'vue';
import type { Ref } from 'vue';
import { listRows } from '@/api/crud';
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

// Server list cap — one page covers every FK target table today.
export const FK_OPTIONS_LIMIT = 500;

interface FkTableEntry {
  rows: Ref<ReadonlyArray<object>>;
  loading: Ref<boolean>;
  reload: () => Promise<void>;
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
        const result = await listRows(table, { limit: FK_OPTIONS_LIMIT });
        rows.value = result.ok ? result.data : [];
      } finally {
        loading.value = false;
      }
    };
    entry = { rows, loading, reload };
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

export function useForeignKeyOptions(
  fk: ForeignKeyDef,
  getParentValue?: () => string | undefined,
) {
  if (!isTableKey(fk.table)) throw new Error(`Unknown foreign-key table '${fk.table}'`);
  const table = fk.table;
  const dependency = fk.dependsOn;

  if (!dependency) {
    const entry = acquire(table);
    const options = computed(() => toOptions(entry.rows.value, fk));
    return { options, loading: entry.loading, labelFor: makeLabelFor(options) };
  }

  // Dependent options are filtered by the parent's value — per-instance, never cached.
  // Refetched only when the parent value changes, preventing refetch storms in a form.
  const filterField = dependency.foreignField;
  const options = ref<SelectOption[]>([]);
  const loading = ref(false);

  async function load(parentValue?: string) {
    if (!parentValue) {
      options.value = [];
      return;
    }
    loading.value = true;
    try {
      const result = await listRows(table, {
        filters: { [filterField]: parentValue },
        limit: FK_OPTIONS_LIMIT,
      });
      options.value = result.ok ? toOptions(result.data, fk) : [];
    } finally {
      loading.value = false;
    }
  }

  if (getParentValue) {
    watch(getParentValue, (newVal) => {
      void load(newVal);
    }, { immediate: true });
  }

  return { options, loading, labelFor: makeLabelFor(options) };
}
