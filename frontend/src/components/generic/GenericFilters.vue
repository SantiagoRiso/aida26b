<script setup lang="ts">
import { ref, computed } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { useAuthStore } from '@/stores/auth';
import { i18n } from '@/i18n';
import { structure } from '@shared/ssot/structure';
import { isInternalColumn, BUSINESS_ID_COLUMN } from '@shared/utils/utils';
import type { ColumnDef, ForeignKeyDef } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import AppButton from '@/components/shared/AppButton.vue';
import ForeignKeySelect from '@/components/shared/ForeignKeySelect.vue';

const props = defineProps<{ tableKey: TableKey; initial?: Record<string, string> }>();
const emit = defineEmits<{ change: [filters: Record<string, string>] }>();

const { label } = useLabel();
const auth = useAuthStore();
// Chrome literals below use the global i18n instance (not useI18n()) — mounted by many
// consumers, not all of which register the i18n plugin in their tests.

interface FilterEntry {
  field: string;
  negated: boolean;
  value: string;
  min: string;
  max: string;
}

// Only an Admin with no business of their own spans tenants. Fail closed: an unknown viewer is
// never treated as one.
const spansTenants = computed(() => auth.user?.role === 'Admin' && auth.user.business_id == null);

// A column may be filterable for API callers and still be wrong to offer here. The pk asks the
// viewer for a raw id they are never shown, and a session-bound business can only narrow a list to
// what it already contains: only a tenant-spanning viewer has a business worth choosing.
function offerable(key: string): boolean {
  if (key === BUSINESS_ID_COLUMN) return spansTenants.value;
  return !isInternalColumn(props.tableKey, key);
}

const filterableColumns = computed(() => {
  const cols = structure.tables[props.tableKey].columns as Record<string, ColumnDef>;
  return Object.entries(cols)
    .filter(([key, col]) => col.filterable && offerable(key))
    .map(([key, col]) => ({ key, col }));
});

const filters = ref<FilterEntry[]>(deserialize(props.initial));
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

function isDateField(field: string): boolean {
  return colForField(field)?.type === 'date';
}

function isBooleanField(field: string): boolean {
  return colForField(field)?.type === 'boolean';
}

// Numbers and dates share the 'min,max' range contract; every other type carries a single value.
function isRangeField(field: string): boolean {
  return isNumericField(field) || isDateField(field);
}

function isEnumField(field: string): boolean {
  return (colForField(field)?.options?.length ?? 0) > 0;
}

// The backend matches a referenced id exactly, so free text on such a column can only ever miss.
// It is picked from the referenced rows instead, by name.
function foreignKeyForField(field: string): ForeignKeyDef | undefined {
  return colForField(field)?.foreignKey;
}

// Serializes active filters to the filter_ query contract.
// Negation: prefix with '!'. Numeric and date ranges: 'min,max'.
function serialize(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters.value) {
    if (isRangeField(f.field)) {
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

// Rebuilds the editable rows from an already-serialized filter set (a restored URL). Fields the
// table doesn't declare filterable are dropped rather than shown as uneditable rows.
function deserialize(source: Record<string, string> | undefined): FilterEntry[] {
  const entries: FilterEntry[] = [];
  for (const [field, raw] of Object.entries(source ?? {})) {
    if (!colForField(field)?.filterable || raw === '') continue;
    const negated = raw.startsWith('!');
    const value = negated ? raw.slice(1) : raw;
    if (isRangeField(field)) {
      const [min = '', max = ''] = value.split(',');
      entries.push({ field, negated, value: '', min, max });
    } else {
      entries.push({ field, negated, value, min: '', max: '' });
    }
  }
  return entries;
}

// Ties the field name beside a filter row to the control it names, so the control has an
// accessible name instead of only a visually adjacent one.
function controlId(field: string): string {
  return `filter-${props.tableKey}-${field}`;
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
        class="min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm sm:flex-none"
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
        {{ i18n.global.t('generic.add') }}
      </AppButton>
    </div>

    <div v-for="f in filters" :key="f.field" class="flex flex-wrap items-center gap-2 rounded-md bg-surface px-3 py-2">
      <span v-if="isRangeField(f.field)" class="text-sm font-semibold">
        {{ label(colForField(f.field)?.label) }}
      </span>
      <label v-else :for="controlId(f.field)" class="text-sm font-semibold">
        {{ label(colForField(f.field)?.label) }}
      </label>

      <label class="flex items-center gap-1 text-xs text-neutral">
        <input type="checkbox" v-model="f.negated" class="accent-accent" @change="onValueChange" />
        {{ i18n.global.t('generic.exclude') }}
      </label>

      <template v-if="isNumericField(f.field)">
        <input
          v-model="f.min"
          type="number"
          class="w-20 rounded border border-border px-2 py-1 text-sm"
          :placeholder="i18n.global.t('generic.minPlaceholder')"
          :aria-label="`${label(colForField(f.field)?.label)} ${i18n.global.t('generic.minPlaceholder')}`"
          @input="onValueChange"
        />
        <span class="text-xs text-neutral">-</span>
        <input
          v-model="f.max"
          type="number"
          class="w-20 rounded border border-border px-2 py-1 text-sm"
          :placeholder="i18n.global.t('generic.maxPlaceholder')"
          :aria-label="`${label(colForField(f.field)?.label)} ${i18n.global.t('generic.maxPlaceholder')}`"
          @input="onValueChange"
        />
      </template>

      <template v-else-if="isDateField(f.field)">
        <input
          v-model="f.min"
          type="date"
          class="rounded border border-border px-2 py-1 text-sm"
          :aria-label="i18n.global.t('generic.from')"
          @input="onValueChange"
        />
        <span class="text-xs text-neutral">-</span>
        <input
          v-model="f.max"
          type="date"
          class="rounded border border-border px-2 py-1 text-sm"
          :aria-label="i18n.global.t('generic.to')"
          @input="onValueChange"
        />
      </template>

      <template v-else-if="isBooleanField(f.field)">
        <select
          :id="controlId(f.field)"
          v-model="f.value"
          class="rounded border border-border px-2 py-1 text-sm"
          @change="onValueChange"
        >
          <option value="">{{ i18n.global.t('generic.all') }}</option>
          <option value="true">{{ i18n.global.t('generic.yes') }}</option>
          <option value="false">{{ i18n.global.t('generic.no') }}</option>
        </select>
      </template>

      <template v-else-if="isEnumField(f.field)">
        <select
          :id="controlId(f.field)"
          v-model="f.value"
          class="rounded border border-border px-2 py-1 text-sm"
          @change="onValueChange"
        >
          <option value="">{{ i18n.global.t('generic.all') }}</option>
          <option
            v-for="opt in colForField(f.field)?.options"
            :key="opt.value"
            :value="opt.value"
          >
            {{ label(opt.label) }}
          </option>
        </select>
      </template>

      <template v-else-if="foreignKeyForField(f.field)">
        <div class="w-56 max-w-full">
          <ForeignKeySelect
            :id="controlId(f.field)"
            :foreign-key="foreignKeyForField(f.field)!"
            :model-value="f.value || null"
            :placeholder="i18n.global.t('generic.all')"
            @update:model-value="f.value = $event ?? ''; onValueChange()"
          />
        </div>
      </template>

      <template v-else>
        <input
          :id="controlId(f.field)"
          v-model="f.value"
          type="text"
          class="w-40 max-w-full rounded border border-border px-2 py-1 text-sm"
          :placeholder="i18n.global.t('generic.filterPlaceholder')"
          @input="onValueChange"
        />
      </template>

      <button
        type="button"
        class="ml-auto text-xs text-neutral hover:text-destructive"
        :aria-label="`${i18n.global.t('generic.removeFilter')}: ${label(colForField(f.field)?.label)}`"
        @click="removeFilter(f.field)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
