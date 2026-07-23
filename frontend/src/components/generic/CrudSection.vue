<script setup lang="ts" generic="K extends TableKey">
import { ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { i18n } from '@/i18n';
import { deleteRow } from '@/api/crud';
import { apiErrorMessage } from '@/i18n/api-errors';
import { invalidateFkOptions } from '@/composables/useForeignKeyOptions';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor } from '@/router/access';
import { structure } from '@shared/ssot/structure';
import type { TableStructure, LocalizedText, ColumnValue } from '@shared/types/types';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import GenericTable from '@/components/generic/GenericTable.vue';
import GenericForm from '@/components/generic/GenericForm.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import AppButton from '@/components/shared/AppButton.vue';

const props = defineProps<{
  tableKey: K;
  panelTitle: LocalizedText | string;
  deleteLabel: LocalizedText | string;
  deleteBody: LocalizedText | string;
  hideTitle?: boolean;
  hideFilters?: boolean;
}>();

const { label } = useLabel();
const { toast } = useToast();
const auth = useAuthStore();

const panelOpen = ref(false);
const editingRow = ref<Wire<TableRecordMap[K]> | null>(null);
const mode = ref<'create' | 'edit'>('create');
const confirmOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);
const reloadKey = ref(0);

function canDelete(): boolean {
  const required = (structure.tables[props.tableKey] as TableStructure).roleRequired?.delete;
  return auth.user ? roleAllowedFor(required, auth.user.role) : false;
}

function rowId(row: Wire<TableRecordMap[K]>): string {
  const pk = (structure.tables[props.tableKey] as TableStructure).pk;
  const pkKey = Array.isArray(pk) ? pk[0] : pk;
  return String((row as Partial<Record<string, ColumnValue>>)[pkKey]);
}

function onEdit(row: Wire<TableRecordMap[K]>) {
  editingRow.value = row;
  mode.value = 'edit';
  panelOpen.value = true;
}

function onCreate() {
  editingRow.value = null;
  mode.value = 'create';
  panelOpen.value = true;
}

function onSaved() {
  panelOpen.value = false;
  toast('success', 'saved');
  reloadKey.value++;
  // Other screens resolve FK labels against this table from a shared cache — refresh it.
  invalidateFkOptions(props.tableKey);
}

// Read editingRow in the script (not the template) — passing the ref-unwrapped generic value
// through the template confuses vue-tsc's generic-component inference.
function onDeleteClick() {
  if (editingRow.value) requestDelete(editingRow.value);
}

function requestDelete(row: Wire<TableRecordMap[K]>) {
  pendingDeleteId.value = rowId(row);
  confirmOpen.value = true;
}

async function confirmDelete() {
  if (!pendingDeleteId.value) return;
  confirmOpen.value = false;
  const result = await deleteRow(props.tableKey, pendingDeleteId.value);
  if (result.ok) {
    reloadKey.value++;
    invalidateFkOptions(props.tableKey);
  } else {
    // A blocked delete carries a translatable code (e.g. an FK still references the row → conflict);
    // show it rather than the opaque generic toast.
    toast('error', apiErrorMessage(result, 'toast.genericError'));
  }
  pendingDeleteId.value = null;
}
</script>

<template>
  <div>
    <GenericTable :key="reloadKey" :table-key="tableKey" :hide-title="hideTitle" :hide-filters="hideFilters" @create="onCreate" @edit="onEdit">
      <!-- Forward table slots (row-actions, header-actions) so sections can add per-row or
           header controls without leaving the generic pipeline. Forwarding only the slots the
           caller provides keeps existing consumers rendering exactly as before. -->
      <template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
        <slot :name="name" v-bind="slotProps" />
      </template>
    </GenericTable>

    <DetailPanel :open="panelOpen" :title="label(panelTitle)" @close="panelOpen = false">
      <GenericForm
        :table-key="tableKey"
        :mode="mode"
        :initial="editingRow ?? undefined"
        @saved="onSaved"
        @cancel="panelOpen = false"
      />
      <div v-if="editingRow && canDelete()" class="mt-6 border-t border-border pt-4">
        <AppButton variant="destructive" class="w-full" @click="onDeleteClick">
          {{ label(deleteLabel) }}
        </AppButton>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="confirmOpen"
      :title="label(deleteLabel)"
      :body="label(deleteBody)"
      :confirm-label="i18n.global.t('actions.delete')"
      :destructive="true"
      @confirm="confirmDelete"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
