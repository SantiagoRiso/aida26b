<script setup lang="ts">
import { ref, computed } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { i18n } from '@/i18n';
import { structure } from '@shared/ssot/structure';
import type { ColumnDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import AppButton from '@/components/shared/AppButton.vue';

const props = defineProps<{ tableKey: TableKey }>();
const emit = defineEmits<{ change: [filters: Record<string, string>] }>();

const { label } = useLabel();
// Chrome literals below use the global i18n instance (not useI18n()) — mounted by many
// consumers, not all of which register the i18n plugin in their tests.

interface FilterEntry {
  field: string;
  negated: boolean;
  value: string;
  min: string;
  max: string;
}

const filterableColumns = computed(() => {
  const cols = structure.tables[props.tableKey].columns as Record<string, ColumnDef>;
  return Object.entries(cols)
    .filter(([, col]) => col.filterable)
    .map(([key, col]) => ({ key, col }));
});

const filters = ref<FilterEntry[]>([]);
const selectedField = ref('');

function addFilter() {
  const field = selectedField.value;
  if (!field || filters.value.some((f) => f.field === field)) return;
  filters.value.push({ field, negated: false, value: '', min: '', max: '' });
  selectedField.value = '';
  emit('change', serialize());
}

function removeFilter(field: string) {
  filters.value = filters.value.filter((f) => f.field !== field);
  emit('change', serialize());
}

function colForField(field: string): ColumnDef | undefined {
  return (structure.tables[props.tableKey].columns as Record<string, ColumnDef>)[field];
}

function isNumericField(field: string): boolean {
  return colForField(field)?.type === 'number';
}

function isEnumField(field: string): boolean {
  return (colForField(field)?.options?.length ?? 0) > 0;
}

// Serializes active filters to the filter_ query contract.
// Negation: prefix with '!'. Numeric range: 'min,max'.
function serialize(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters.value) {
    if (isNumericField(f.field)) {
      if (f.min !== '' || f.max !== '') {
        const raw = `${f.min},${f.max}`;
        out[f.field] = f.negated ? `!${raw}` : raw;
      }
    } else {
      if (f.value !== '') {
        out[f.field] = f.negated ? `!${f.value}` : f.value;
      }
    }
  }
  return out;
}

function onValueChange() {
  emit('change', serialize());
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <select
        v-model="selectedField"
        class="rounded-md border border-border bg-card px-3 py-2 text-sm"
        :aria-label="i18n.global.t('generic.selectColumnAria')"
      >
        <option value="">{{ i18n.global.t('generic.addFilterPlaceholder') }}</option>
        <option
          v-for="{ key, col } in filterableColumns"
          :key="key"
          :value="key"
          :disabled="filters.some((f) => f.field === key)"
        >
          {{ label(col.label) }}
        </option>
      </select>
      <AppButton size="sm" :disabled="!selectedField" @click="addFilter">
        {{ label({ es: 'Agregar', en: 'Add' }) }}
      </AppButton>
    </div>

    <div v-for="f in filters" :key="f.field" class="flex flex-wrap items-center gap-2 rounded-md bg-surface px-3 py-2">
      <span class="text-sm font-semibold">{{ label(colForField(f.field)?.label) }}</span>

      <label class="flex items-center gap-1 text-xs text-neutral">
        <input type="checkbox" v-model="f.negated" class="accent-accent" @change="onValueChange" />
        {{ label({ es: 'excluir', en: 'exclude' }) }}
      </label>

      <template v-if="isNumericField(f.field)">
        <input
          v-model="f.min"
          type="number"
          class="w-20 rounded border border-border px-2 py-1 text-sm"
          :placeholder="label({ es: 'mín', en: 'min' })"
          @input="onValueChange"
        />
        <span class="text-xs text-neutral">–</span>
        <input
          v-model="f.max"
          type="number"
          class="w-20 rounded border border-border px-2 py-1 text-sm"
          :placeholder="label({ es: 'máx', en: 'max' })"
          @input="onValueChange"
        />
      </template>

      <template v-else-if="isEnumField(f.field)">
        <select
          v-model="f.value"
          class="rounded border border-border px-2 py-1 text-sm"
          @change="onValueChange"
        >
          <option value="">{{ label({ es: 'Todos', en: 'All' }) }}</option>
          <option
            v-for="opt in colForField(f.field)?.options"
            :key="opt.value"
            :value="opt.value"
          >
            {{ label(opt.label) }}
          </option>
        </select>
      </template>

      <template v-else>
        <input
          v-model="f.value"
          type="text"
          class="w-40 rounded border border-border px-2 py-1 text-sm"
          :placeholder="i18n.global.t('generic.filterPlaceholder')"
          @input="onValueChange"
        />
      </template>

      <button
        type="button"
        class="ml-auto text-xs text-neutral hover:text-destructive"
        @click="removeFilter(f.field)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
