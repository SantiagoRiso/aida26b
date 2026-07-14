import { ref, computed, watch } from 'vue';
import type { Ref } from 'vue';
import { listRows } from '@/api/crud';
import type { ColumnValue, ForeignKeyDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';

export interface SelectOption {
  value: string;
  label: string;
}

// Server list cap — one page covers every FK target table today.
export const FK_OPTIONS_LIMIT = 500;

interface FkOptionsEntry {
  options: Ref<SelectOption[]>;
  loading: Ref<boolean>;
  labelFor: (id: string | number | null | undefined) => string | null;
  reload: () => Promise<void>;
}

// One fetch per (table, valueField, labelField) app-wide; every consumer shares
// the same reactive options, so late mounts and early rows resolve alike.
const cache = new Map<string, FkOptionsEntry>();

function toOptions(rows: ReadonlyArray<object>, fk: ForeignKeyDef): SelectOption[] {
  return rows.map((row) => {
    const r = row as Record<string, ColumnValue>;
    return {
      value: String(r[fk.valueField] ?? ''),
      label: String(r[fk.labelField] ?? ''),
    };
  });
}

function makeLabelFor(options: Ref<SelectOption[]>): FkOptionsEntry['labelFor'] {
  const optionMap = computed(() => {
    const m = new Map<string, string>();
    for (const o of options.value) m.set(o.value, o.label);
    return m;
  });
  // Resolve an id to its display label — the id→name lookup every consumer needs, so no screen
  // has to rebuild it. Returns null for a missing/unknown id so callers can pick their own fallback.
  return (id) => {
    if (id == null) return null;
    return optionMap.value.get(String(id)) ?? null;
  };
}

function acquire(fk: ForeignKeyDef): FkOptionsEntry {
  const key = `${fk.table}|${fk.valueField}|${fk.labelField}`;
  let entry = cache.get(key);
  if (!entry) {
    const options = ref<SelectOption[]>([]);
    const loading = ref(false);
    const reload = async () => {
      loading.value = true;
      try {
        const result = await listRows(fk.table as TableKey, { limit: FK_OPTIONS_LIMIT });
        options.value = result.ok ? toOptions(result.data, fk) : [];
      } finally {
        loading.value = false;
      }
    };
    entry = { options, loading, labelFor: makeLabelFor(options), reload };
    cache.set(key, entry);
    void entry.reload();
  }
  return entry;
}

// After a write to a referenced table, refetch its cached options so live
// consumers don't keep showing pre-edit labels.
export function invalidateFkOptions(table: string): void {
  for (const [key, entry] of cache) {
    if (key.startsWith(`${table}|`)) void entry.reload();
  }
}

export function resetFkOptionsCache(): void {
  cache.clear();
}

export function useForeignKeyOptions(
  fk: ForeignKeyDef,
  getParentValue?: () => string | undefined,
) {
  if (!fk.dependsOn) {
    const entry = acquire(fk);
    return { options: entry.options, loading: entry.loading, labelFor: entry.labelFor };
  }

  // Dependent options are filtered by the parent's value — per-instance, never cached.
  // Refetched only when the parent value changes, preventing refetch storms in a form.
  const options = ref<SelectOption[]>([]);
  const loading = ref(false);

  async function load(parentValue?: string) {
    if (!parentValue) {
      options.value = [];
      return;
    }
    loading.value = true;
    try {
      const result = await listRows(fk.table as TableKey, {
        filters: { [fk.dependsOn!.foreignField]: parentValue },
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
