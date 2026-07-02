<script setup lang="ts">
import { ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { deleteRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import GenericTable from '@/components/generic/GenericTable.vue';
import GenericForm from '@/components/generic/GenericForm.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const { label } = useLabel();
const { toast } = useToast();

const TABLE_KEY = 'resources' as const;

const panelOpen = ref(false);
const editingRow = ref<Record<string, unknown> | null>(null);
const mode = ref<'create' | 'edit'>('create');
const confirmOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);
const reloadKey = ref(0);

function onEdit(row: Record<string, unknown>) {
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
  reloadKey.value++;
}

function requestDelete(row: Record<string, unknown>) {
  pendingDeleteId.value = String(row.id ?? '');
  confirmOpen.value = true;
}

async function confirmDelete() {
  if (!pendingDeleteId.value) return;
  confirmOpen.value = false;
  const result = await deleteRow(TABLE_KEY, pendingDeleteId.value);
  if (result.ok) {
    reloadKey.value++;
  } else {
    toast('error', 'genericError');
  }
  pendingDeleteId.value = null;
}
</script>

<template>
  <div>
    <GenericTable
      :key="reloadKey"
      :table-key="TABLE_KEY"
      @create="onCreate"
      @edit="onEdit"
    />

    <DetailPanel :open="panelOpen" :title="label({ es: 'Recurso', en: 'Resource' })" @close="panelOpen = false">
      <GenericForm
        :table-key="TABLE_KEY"
        :mode="mode"
        :initial="editingRow ?? undefined"
        @saved="onSaved"
        @cancel="panelOpen = false"
      />
      <div v-if="editingRow" class="mt-6 border-t border-border pt-4">
        <button
          type="button"
          class="w-full rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-white hover:bg-destructive-hover"
          @click="requestDelete(editingRow)"
        >
          {{ label({ es: 'Eliminar recurso', en: 'Delete resource' }) }}
        </button>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="confirmOpen"
      :title="label({ es: 'Eliminar recurso', en: 'Delete resource' })"
      :body="label({ es: 'Esta acción no se puede deshacer. ¿Confirmás?', en: 'This action cannot be undone. Confirm?' })"
      :confirm-label="label({ es: 'Eliminar', en: 'Delete' })"
      :destructive="true"
      @confirm="confirmDelete"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
