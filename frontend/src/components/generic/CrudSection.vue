<script setup lang="ts" generic="K extends TableKey">
import { ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { deleteRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor } from '@/router/access';
import { structure } from '@shared/ssot/structure';
import type { TableKey, TableRecordMap, TableStructure, LocalizedText, ColumnValue } from '@shared/types/types';
import GenericTable from '@/components/generic/GenericTable.vue';
import GenericForm from '@/components/generic/GenericForm.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const props = defineProps<{
  tableKey: K;
  panelTitle: LocalizedText;
  deleteLabel: LocalizedText;
  deleteBody: LocalizedText;
}>();

const { label } = useLabel();
const { toast } = useToast();
const auth = useAuthStore();

const panelOpen = ref(false);
const editingRow = ref<TableRecordMap[K] | null>(null);
const mode = ref<'create' | 'edit'>('create');
const confirmOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);
const reloadKey = ref(0);

function canDelete(): boolean {
  const required = (structure.tables[props.tableKey] as TableStructure).roleRequired?.delete;
  return auth.user ? roleAllowedFor(required, auth.user.role) : false;
}

function rowId(row: TableRecordMap[K]): string {
  const pk = (structure.tables[props.tableKey] as TableStructure).pk;
  const pkKey = Array.isArray(pk) ? pk[0] : pk;
  return String((row as Record<string, ColumnValue>)[pkKey]);
}

function onEdit(row: TableRecordMap[K]) {
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
}

// Read editingRow in the script (not the template) — passing the ref-unwrapped generic value
// through the template confuses vue-tsc's generic-component inference.
function onDeleteClick() {
  if (editingRow.value) requestDelete(editingRow.value);
}

function requestDelete(row: TableRecordMap[K]) {
  pendingDeleteId.value = rowId(row);
  confirmOpen.value = true;
}

async function confirmDelete() {
  if (!pendingDeleteId.value) return;
  confirmOpen.value = false;
  const result = await deleteRow(props.tableKey, pendingDeleteId.value);
  if (result.ok) reloadKey.value++;
  else toast('error', 'genericError');
  pendingDeleteId.value = null;
}
</script>

<template>
  <div>
    <GenericTable :key="reloadKey" :table-key="tableKey" @create="onCreate" @edit="onEdit" />

    <DetailPanel :open="panelOpen" :title="label(panelTitle)" @close="panelOpen = false">
      <GenericForm
        :table-key="tableKey"
        :mode="mode"
        :initial="editingRow ?? undefined"
        @saved="onSaved"
        @cancel="panelOpen = false"
      />
      <div v-if="editingRow && canDelete()" class="mt-6 border-t border-border pt-4">
        <button
          type="button"
          class="w-full rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-white hover:bg-destructive-hover"
          @click="onDeleteClick"
        >
          {{ label(deleteLabel) }}
        </button>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="confirmOpen"
      :title="label(deleteLabel)"
      :body="label(deleteBody)"
      :confirm-label="label({ es: 'Eliminar', en: 'Delete' })"
      :destructive="true"
      @confirm="confirmDelete"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
