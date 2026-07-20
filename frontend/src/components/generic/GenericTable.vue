<script setup lang="ts" generic="K extends TableKey">
import { ref, computed, watch, useSlots } from 'vue';
import type { Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { i18n } from '@/i18n';
import { roleAllowedFor } from '@/router/access';
import { listRows } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import type { ForeignKeyValue } from '@/composables/useForeignKeyOptions';
import { structure } from '@shared/ssot/structure';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import type { ColumnDef, ColumnValue, TableStructure } from '@shared/types/types';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import GenericFilters from '@/components/generic/GenericFilters.vue';
import Pagination from '@/components/generic/Pagination.vue';

const props = defineProps<{
  tableKey: K;
  hideTitle?: boolean;
  hideFilters?: boolean;
  emptyValue?: string;
}>();

// Rows are emitted exactly as the API sent them: uncoerced wire values (NUMERIC/BIGINT arrive
// as strings), so consumers see the true shape rather than the coerced record type.
const emit = defineEmits<{
  edit: [row: Wire<TableRecordMap[K]>];
  create: [];
}>();

const auth = useAuthStore();
const { label } = useLabel();

// Widened to TableStructure: the per-table literal union makes optional members
// like crud/roleRequired inaccessible on tables that omit them.
const tableSpec = computed<TableStructure>(() => structure.tables[props.tableKey]);

const columns = computed(() => {
  const cols = tableSpec.value.columns as Record<string, ColumnDef>;
  return Object.entries(cols).map(([key, col]) => ({ key, col }));
});

// Surrogate keys carry no business meaning to a viewer — hide them from display.
const visibleColumns = computed(() =>
  columns.value.filter(({ key }) => key !== tableSpec.value.pk && key !== 'business_id'),
);

const userRole = computed(() => auth.user?.role);

function canCreate(): boolean {
  const crud = tableSpec.value.crud;
  if (!crud?.create) return false;
  const required = tableSpec.value.roleRequired?.create;
  if (!userRole.value) return false;
  return roleAllowedFor(required, userRole.value);
}

function canUpdate(): boolean {
  const crud = tableSpec.value.crud;
  if (!crud?.update) return false;
  const required = tableSpec.value.roleRequired?.update;
  if (!userRole.value) return false;
  return roleAllowedFor(required, userRole.value);
}

function canDelete(): boolean {
  const crud = tableSpec.value.crud;
  if (!crud?.delete) return false;
  const required = tableSpec.value.roleRequired?.delete;
  if (!userRole.value) return false;
  return roleAllowedFor(required, userRole.value);
}

const sortField = ref('');
const sortDir = ref<'asc' | 'desc'>('asc');

function toggleSort(field: string) {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    sortDir.value = 'asc';
  }
  reload();
}

const page = ref(1);
const filters = ref<Record<string, string>>({});
const rows = ref([]) as Ref<Wire<TableRecordMap[K]>[]>;
const total = ref(0);
// The server is the sole authority on page size; this only seeds the pre-first-response render.
// Once a response lands, limit tracks meta.limit so the widget can never disagree with what
// the server actually paginated by (see Pagination's totalPages math).
const limit = ref(LIST_DEFAULT_LIMIT);
const loading = ref(false);
const loadError = ref(false);

async function reload() {
  loading.value = true;
  loadError.value = false;
  try {
    const result = await listRows(props.tableKey, {
      page: page.value,
      sort: sortField.value || undefined,
      dir: sortDir.value,
      filters: filters.value,
    });
    if (result.ok) {
      rows.value = result.data;
      total.value = result.meta?.total ?? rows.value.length;
      limit.value = result.meta?.limit ?? LIST_DEFAULT_LIMIT;
    } else {
      loadError.value = true;
    }
  } finally {
    loading.value = false;
  }
}

function onFiltersChange(f: Record<string, string>) {
  filters.value = f;
  page.value = 1;
  reload();
}

function onPageChange(p: number) {
  page.value = p;
  reload();
}

// FK columns render the referenced row's label, not its id. Lookups come from the shared
// useForeignKeyOptions cache (one fetch per referenced table app-wide); the resolvers read
// reactive options, so labels fill in whether rows or options arrive first.
const fkLabelFns = ref<Record<string, (id: ForeignKeyValue) => string | null>>({});

function bindFkResolvers() {
  const cols = tableSpec.value.columns as Record<string, ColumnDef>;
  const fns: Record<string, (id: ForeignKeyValue) => string | null> = {};
  for (const col of Object.values(cols)) {
    if (col.foreignKey) fns[col.foreignKey.table] = useForeignKeyOptions(col.foreignKey).labelFor;
  }
  fkLabelFns.value = fns;
}

watch(() => props.tableKey, () => {
  page.value = 1;
  sortField.value = '';
  filters.value = {};
  rows.value = [];
  total.value = 0;
  reload();
  bindFkResolvers();
}, { immediate: true });

const addLabel = computed(() => {
  const tbl = tableSpec.value;
  return 'addButtonLabel' in tbl && tbl.addButtonLabel
    ? label(tbl.addButtonLabel as { es: string; en: string })
    : i18n.global.t('generic.newButton');
});

const tableTitle = computed(() => {
  const tbl = tableSpec.value;
  return 'title' in tbl && tbl.title
    ? label(tbl.title as { es: string; en: string })
    : label(tbl.uiName);
});

const slots = useSlots();
const hasActionsColumn = computed(() => canUpdate() || canDelete() || !!slots['row-actions']);

function formatCell(value: ColumnValue | undefined): string {
  if (value === null || value === undefined || value === '')
    return props.emptyValue ?? i18n.global.t('generic.emptyValue');
  if (typeof value === 'boolean') return value ? i18n.global.t('generic.yes') : i18n.global.t('generic.no');
  return String(value);
}

// Column keys come from the SSOT columns map at runtime, so cells are read by name.
function cellValue(row: Wire<TableRecordMap[K]>, key: string): ColumnValue | undefined {
  return (row as Partial<Record<string, ColumnValue>>)[key];
}

// FK cells show the referenced row's label; a read-restricted or missing target falls
// back to the raw id rather than hiding the value entirely.
function cellDisplay(row: Wire<TableRecordMap[K]>, key: string, col: ColumnDef): string {
  if (col.foreignKey) {
    const v = cellValue(row, key);
    if (v == null || v === '') return props.emptyValue ?? i18n.global.t('generic.emptyValue');
    return fkLabelFns.value[col.foreignKey.table]?.(String(v)) || `#${v}`;
  }
  return formatCell(cellValue(row, key));
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 v-if="!hideTitle" class="text-2xl font-semibold">{{ tableTitle }}</h1>
      <div v-else></div>
      <div class="flex items-center gap-2">
        <slot name="header-actions" />
        <AppButton
          v-if="canCreate()"
          variant="primary"
          @click="emit('create')"
        >
          {{ addLabel }}
        </AppButton>
      </div>
    </div>

    <GenericFilters v-if="!hideFilters" :table-key="tableKey" @change="onFiltersChange" />

    <div class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="sticky top-0 z-10 bg-surface text-left">
          <tr>
            <th
              v-for="{ key, col } in visibleColumns"
              :key="key"
              class="px-4 py-3 font-semibold"
              :class="col.sortable ? 'cursor-pointer select-none hover:bg-border' : ''"
              @click="col.sortable ? toggleSort(key) : undefined"
            >
              {{ label(col.label) }}
              <span v-if="col.sortable && sortField === key" class="ml-1 text-xs text-neutral">
                {{ sortDir === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th v-if="hasActionsColumn" class="px-4 py-3 font-semibold text-right">
              {{ i18n.global.t('generic.actionsColumn') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading">
            <tr>
              <td :colspan="visibleColumns.length + (hasActionsColumn ? 1 : 0)" class="p-4">
                <Skeleton variant="row" :rows="4" />
              </td>
            </tr>
          </template>
          <template v-else-if="rows.length === 0">
            <tr>
              <td :colspan="visibleColumns.length + (hasActionsColumn ? 1 : 0)" class="p-4">
                <EmptyState
                  :heading="i18n.global.t('emptyState.noItemsToShowHeading', { entity: tableTitle })"
                  :body="i18n.global.t('emptyState.noItemsBody')"
                />
              </td>
            </tr>
          </template>
          <template v-else>
            <tr
              v-for="row in rows"
              :key="String(cellValue(row, tableSpec.pk as string) ?? '')"
              class="virtualized-row border-t border-border hover:bg-surface"
              :class="canUpdate() ? 'cursor-pointer' : ''"
              @click="canUpdate() ? emit('edit', row) : undefined"
            >
              <td
                v-for="{ key, col } in visibleColumns"
                :key="key"
                class="max-w-xs truncate px-4 py-3"
                :title="cellDisplay(row, key, col)"
              >
                {{ cellDisplay(row, key, col) }}
              </td>
              <td v-if="hasActionsColumn" class="px-4 py-3 text-right whitespace-nowrap">
                <slot name="row-actions" :row="row" />
                <button
                  v-if="canUpdate()"
                  type="button"
                  class="mr-2 text-accent hover:underline text-xs"
                  @click.stop="emit('edit', row)"
                >
                  {{ i18n.global.t('actions.edit') }}
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <Pagination
      v-if="!loading && (rows.length > 0 || page > 1)"
      :page="page"
      :limit="limit"
      :total="total"
      @change="onPageChange"
    />
  </div>
</template>
