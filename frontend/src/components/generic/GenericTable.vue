<script setup lang="ts" generic="K extends TableKey">
import { ref, computed, watch, useSlots } from 'vue';
import type { Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { roleAllowedFor } from '@/router/access';
import { listRows } from '@/api/crud';
import { structure } from '@shared/ssot/structure';
import type { TableKey, TableRecordMap, ColumnDef, ColumnValue, TableStructure } from '@shared/types/types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import GenericFilters from '@/components/generic/GenericFilters.vue';
import Pagination from '@/components/generic/Pagination.vue';

const props = defineProps<{
  tableKey: K;
}>();

const emit = defineEmits<{
  edit: [row: TableRecordMap[K]];
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
const rows = ref([]) as Ref<TableRecordMap[K][]>;
const total = ref(0);
const limit = 20;
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

// Resolved once per table switch: FK columns render the referenced row's label, not its id.
const fkLabelMaps = ref<Record<string, Map<string, string>>>({});

async function loadFkLabels() {
  const cols = tableSpec.value.columns as Record<string, ColumnDef>;
  const fkTables = new Map<string, { valueField: string; labelField: string }>();
  for (const col of Object.values(cols)) {
    if (col.foreignKey) fkTables.set(col.foreignKey.table, { valueField: col.foreignKey.valueField, labelField: col.foreignKey.labelField });
  }
  const maps: Record<string, Map<string, string>> = {};
  await Promise.all([...fkTables].map(async ([table, { valueField, labelField }]) => {
    const res = await listRows(table as TableKey, { limit: 500 });
    const m = new Map<string, string>();
    if (res.ok) {
      for (const r of res.data as Array<Record<string, ColumnValue>>) {
        const v = r[valueField]; const l = r[labelField];
        if (v != null && l != null) m.set(String(v), String(l));
      }
    }
    maps[table] = m;
  }));
  fkLabelMaps.value = maps;
}

watch(() => props.tableKey, () => {
  page.value = 1;
  sortField.value = '';
  filters.value = {};
  rows.value = [];
  total.value = 0;
  reload();
  loadFkLabels();
}, { immediate: true });

const addLabel = computed(() => {
  const tbl = tableSpec.value;
  return 'addButtonLabel' in tbl && tbl.addButtonLabel
    ? label(tbl.addButtonLabel as { es: string; en: string })
    : label({ es: 'Nuevo', en: 'New' });
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
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? label({ es: 'Sí', en: 'Yes' }) : label({ es: 'No', en: 'No' });
  return String(value);
}

// Column keys come from the SSOT columns map at runtime, so cells are read by name.
function cellValue(row: TableRecordMap[K], key: string): ColumnValue | undefined {
  return (row as Partial<Record<string, ColumnValue>>)[key];
}

// FK cells show the referenced row's label; a read-restricted or missing target falls
// back to the raw id rather than hiding the value entirely.
function cellDisplay(row: TableRecordMap[K], key: string, col: ColumnDef): string {
  if (col.foreignKey) {
    const v = cellValue(row, key);
    if (v == null || v === '') return '—';
    return fkLabelMaps.value[col.foreignKey.table]?.get(String(v)) ?? `#${v}`;
  }
  return formatCell(cellValue(row, key));
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{{ tableTitle }}</h1>
      <div class="flex items-center gap-2">
        <slot name="header-actions" />
        <button
          v-if="canCreate()"
          type="button"
          class="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
          @click="emit('create')"
        >
          {{ addLabel }}
        </button>
      </div>
    </div>

    <GenericFilters :table-key="tableKey" @change="onFiltersChange" />

    <div class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="bg-surface text-left">
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
              {{ label({ es: 'Acciones', en: 'Actions' }) }}
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
                  :heading="label({ es: `No hay ${tableTitle} para mostrar`, en: `No ${tableTitle} to show` })"
                  :body="label({ es: 'Probá ajustar los filtros o creá el primero.', en: 'Try adjusting the filters, or create the first one.' })"
                />
              </td>
            </tr>
          </template>
          <template v-else>
            <tr
              v-for="row in rows"
              :key="String(cellValue(row, tableSpec.pk as string) ?? '')"
              class="border-t border-border hover:bg-surface"
              :class="canUpdate() ? 'cursor-pointer' : ''"
              @click="canUpdate() ? emit('edit', row) : undefined"
            >
              <td v-for="{ key, col } in visibleColumns" :key="key" class="px-4 py-3">
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
                  {{ label({ es: 'Editar', en: 'Edit' }) }}
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <Pagination
      v-if="!loading && rows.length > 0"
      :page="page"
      :limit="limit"
      :total="total"
      @change="onPageChange"
    />
  </div>
</template>
