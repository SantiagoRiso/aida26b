<script setup lang="ts" generic="K extends TableKey">
import { ref, computed, watch, useSlots, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { Ref } from 'vue';
import { findScrollParent, measureTableScrollHeight } from '@/composables/tableScrollHeight';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { i18n } from '@/i18n';
import { roleAllowedFor } from '@/router/access';
import { listRows } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import type { ForeignKeyValue } from '@/composables/useForeignKeyOptions';
import { useListQuerySync } from '@/composables/useListQuerySync';
import { structure } from '@shared/ssot/structure';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import { isInternalColumn } from '@shared/utils/utils';
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

// Surrogate keys and tenant scoping carry no business meaning to a viewer: hide them from
// display. Shared with GenericForm's read-only block via isInternalColumn so the two renderers
// can't drift on what counts as internal.
const visibleColumns = computed(() =>
  columns.value.filter(({ key }) => !isInternalColumn(props.tableKey, key)),
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

const columnKeysWhere = (pick: (col: ColumnDef) => boolean | undefined) =>
  columns.value.filter(({ col }) => pick(col)).map(({ key }) => key);

// List state lives in the URL, so a filtered view survives a reload and can be shared.
const listQuery = useListQuerySync({
  onChange: () => { void reload(); },
  sortableFields: () => columnKeysWhere((col) => col.sortable),
  filterableFields: () => columnKeysWhere((col) => col.filterable),
});
const { page, sort: sortField, dir: sortDir, filters, limit: requestedLimit } = listQuery;

function toggleSort(field: string) {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    sortDir.value = 'asc';
  }
  listQuery.commit();
}

function ariaSort(field: string, sortable?: boolean): 'ascending' | 'descending' | 'none' | undefined {
  if (!sortable) return undefined;
  if (sortField.value !== field) return 'none';
  return sortDir.value === 'asc' ? 'ascending' : 'descending';
}

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
      limit: requestedLimit.value,
      sort: sortField.value || undefined,
      dir: sortDir.value,
      filters: filters.value,
    });
    if (result.ok) {
      rows.value = result.data;
      total.value = result.meta?.total ?? rows.value.length;
      limit.value = result.meta?.limit ?? LIST_DEFAULT_LIMIT;
    } else {
      // A failed load must not read as "no rows" — that reports data the server never confirmed.
      rows.value = [];
      total.value = 0;
      loadError.value = true;
    }
  } finally {
    loading.value = false;
  }
}

// Debounced: typing in a filter must not spam the network or the address bar.
function onFiltersChange(f: Record<string, string>) {
  filters.value = f;
  page.value = 1;
  listQuery.commitDebounced();
}

function onPageChange(p: number) {
  page.value = p;
  listQuery.commit();
}

// FK columns render the referenced row's label, not its id. Lookups come from the shared
// useForeignKeyOptions cache (one fetch per referenced table app-wide); the resolvers read
// reactive options, so labels fill in whether rows or options arrive first. A target past the
// cached page is fetched by id on demand.
interface FkResolver {
  labelFor: (id: ForeignKeyValue) => string | null;
  isUnresolved: (id: ForeignKeyValue) => boolean;
}
const fkResolvers = ref<Record<string, FkResolver>>({});

function bindFkResolvers() {
  const cols = tableSpec.value.columns as Record<string, ColumnDef>;
  const resolvers: Record<string, FkResolver> = {};
  for (const col of Object.values(cols)) {
    if (!col.foreignKey) continue;
    const { labelFor, isUnresolved } = useForeignKeyOptions(col.foreignKey);
    resolvers[col.foreignKey.table] = { labelFor, isUnresolved };
  }
  fkResolvers.value = resolvers;
}

// First run keeps whatever the URL restored; only a genuine table switch clears list state.
watch(() => props.tableKey, (_next, previous) => {
  if (previous !== undefined) listQuery.reset();
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

// The wrapper scrolls horizontally, which also makes it the scrollport the header sticks to. It is
// capped to the room left below it so a long list scrolls under the header instead of carrying it
// off the page; the cap is measured from the layout rather than assumed.
const scrollBox = ref<HTMLElement | null>(null);
const maxScrollHeight = ref<string | null>(null);

function measure() {
  maxScrollHeight.value = scrollBox.value ? measureTableScrollHeight(scrollBox.value) : null;
}

let scrollerResize: ResizeObserver | null = null;
onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
  // The scrolling ancestor, not the table's own container: observing a container whose height
  // follows the table would re-measure on its own result.
  const scroller = scrollBox.value ? findScrollParent(scrollBox.value) : null;
  if (scroller && typeof ResizeObserver !== 'undefined') {
    scrollerResize = new ResizeObserver(measure);
    scrollerResize.observe(scroller);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
  scrollerResize?.disconnect();
});

// Filters collapse and expand above the table, moving where it starts.
watch(filters, () => { void nextTick(measure); }, { deep: true });

// FK cells show the referenced row's label. A target the viewer may not read (archived, another
// tenant's, or gone) reads as unavailable rather than as an id, which would say nothing to an
// operator and would assert the row exists.
function cellDisplay(row: Wire<TableRecordMap[K]>, key: string, col: ColumnDef): string {
  if (col.foreignKey) {
    const v = cellValue(row, key);
    if (v == null || v === '') return props.emptyValue ?? i18n.global.t('generic.emptyValue');
    const resolver = fkResolvers.value[col.foreignKey.table];
    const label = resolver?.labelFor(String(v));
    // Whether declined by the server (isUnresolved) or simply not on the cached page yet, a raw
    // id says nothing to an operator and would assert the row exists: never print it.
    return label ?? i18n.global.t('generic.unresolvedReference');
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

    <GenericFilters
      v-if="!hideFilters"
      :key="tableKey"
      :table-key="tableKey"
      :initial="filters"
      @change="onFiltersChange"
    />

    <div
      ref="scrollBox"
      data-testid="table-scroll"
      class="overflow-auto rounded-lg border border-border"
      :style="maxScrollHeight ? { maxHeight: maxScrollHeight } : undefined"
    >
      <table class="w-full text-sm" :aria-label="tableTitle">
        <thead class="text-left">
          <tr>
            <th
              v-for="{ key, col } in visibleColumns"
              :key="key"
              scope="col"
              class="sticky top-0 z-10 bg-surface font-semibold"
              :class="col.sortable ? '' : 'px-4 py-3'"
              :aria-sort="ariaSort(key, col.sortable)"
            >
              <button
                v-if="col.sortable"
                type="button"
                class="flex w-full select-none items-center px-4 py-3 text-left font-semibold hover:bg-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="toggleSort(key)"
              >
                {{ label(col.label) }}
                <span v-if="sortField === key" class="ml-1 text-xs text-neutral" aria-hidden="true">
                  {{ sortDir === 'asc' ? '↑' : '↓' }}
                </span>
              </button>
              <template v-else>{{ label(col.label) }}</template>
            </th>
            <th
              v-if="hasActionsColumn"
              scope="col"
              class="sticky top-0 z-10 bg-surface px-4 py-3 font-semibold text-right"
            >
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
          <template v-else-if="loadError">
            <tr>
              <td :colspan="visibleColumns.length + (hasActionsColumn ? 1 : 0)" class="p-4">
                <EmptyState
                  :heading="i18n.global.t('emptyState.loadErrorHeading')"
                  :body="i18n.global.t('emptyState.loadErrorBody')"
                />
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
                class="cell-truncate max-w-xs px-4 py-3"
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
      v-if="!loading && !loadError && (rows.length > 0 || page > 1)"
      :page="page"
      :limit="limit"
      :total="total"
      @change="onPageChange"
    />
  </div>
</template>
