import { ref, computed, watch } from 'vue';
import { listRows } from '@/api/crud';
import { useLabel } from '@/composables/useLabel';
import type { ForeignKeyDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';

export interface SelectOption {
  value: string;
  label: string;
}

// Options are refetched only when the parent (dependsOn) value changes, not on
// every render, preventing refetch storms inside a single form instance.
export function useForeignKeyOptions(
  fk: ForeignKeyDef,
  getParentValue?: () => string | undefined,
) {
  const { label } = useLabel();
  const options = ref<SelectOption[]>([]);
  const loading = ref(false);

  async function load(parentValue?: string) {
    if (fk.dependsOn && !parentValue) {
      options.value = [];
      return;
    }
    loading.value = true;
    try {
      const filterParams: Record<string, string> = {};
      if (fk.dependsOn && parentValue) {
        filterParams[fk.dependsOn.foreignField] = parentValue;
      }
      const result = await listRows(fk.table as TableKey, {
        filters: filterParams,
        limit: 200,
      });
      if (result.ok) {
        options.value = result.data.map((row) => ({
          value: String(row[fk.valueField as keyof typeof row] ?? ''),
          label: String(row[fk.labelField as keyof typeof row] ?? ''),
        }));
      } else {
        options.value = [];
      }
    } finally {
      loading.value = false;
    }
  }

  if (fk.dependsOn && getParentValue) {
    watch(getParentValue, (newVal) => {
      void load(newVal);
    }, { immediate: true });
  } else {
    void load();
  }

  const optionMap = computed(() => {
    const m = new Map<string, string>();
    for (const o of options.value) m.set(o.value, o.label);
    return m;
  });

  // Resolve an id to its display label — the id→name lookup every consumer needs, so no screen
  // has to rebuild it. Returns null for a missing/unknown id so callers can pick their own fallback.
  function labelFor(id: string | number | null | undefined): string | null {
    if (id == null) return null;
    return optionMap.value.get(String(id)) ?? null;
  }

  return { options, loading, labelFor };
}
