import { ref, watch } from 'vue';
import { listRows } from '@/api/crud';
import { useLabel } from '@/composables/useLabel';
import type { ForeignKeyDef, TableKey } from '@shared/types/types';

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
      const result = await listRows<Record<string, unknown>>(fk.table as TableKey, {
        filters: filterParams,
        limit: 200,
      });
      if (result.ok) {
        options.value = (result.data as Record<string, unknown>[]).map((row) => ({
          value: String(row[fk.valueField] ?? ''),
          label: String(row[fk.labelField] ?? ''),
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

  return { options, loading };
}
