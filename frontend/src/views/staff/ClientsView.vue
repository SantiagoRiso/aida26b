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

// Clients are deactivated (soft-delete via deleted_at), never created here or hard-deleted.
const TABLE_KEY = 'clients' as const;

const panelOpen = ref(false);
const editingRow = ref<Record<string, unknown> | null>(null);
const confirmOpen = ref(false);
const pendingDeactivateId = ref<string | null>(null);
const pendingDeactivateName = ref('');
const reloadKey = ref(0);

function onEdit(row: Record<string, unknown>) {
  editingRow.value = row;
  panelOpen.value = true;
}

function onSaved() {
  panelOpen.value = false;
  reloadKey.value++;
}

function requestDeactivate(row: Record<string, unknown>) {
  pendingDeactivateId.value = String(row.id ?? '');
  pendingDeactivateName.value = String(row.display_name ?? row.id ?? '');
  confirmOpen.value = true;
}

async function confirmDeactivate() {
  if (!pendingDeactivateId.value) return;
  confirmOpen.value = false;
  const result = await deleteRow(TABLE_KEY, pendingDeactivateId.value);
  if (result.ok) {
    reloadKey.value++;
  } else {
    toast('error', 'genericError');
  }
  pendingDeactivateId.value = null;
}
</script>

<template>
  <div>
    <GenericTable
      :key="reloadKey"
      :table-key="TABLE_KEY"
      @edit="onEdit"
    />

    <DetailPanel :open="panelOpen" :title="label({ es: 'Cliente', en: 'Client' })" @close="panelOpen = false">
      <GenericForm
        :table-key="TABLE_KEY"
        mode="edit"
        :initial="editingRow ?? undefined"
        @saved="onSaved"
        @cancel="panelOpen = false"
      />
      <div v-if="editingRow" class="mt-6 border-t border-border pt-4">
        <button
          type="button"
          class="w-full rounded-md bg-destructive px-4 py-2 text-sm font-semibold text-white hover:bg-destructive-hover"
          @click="requestDeactivate(editingRow)"
        >
          {{ label({ es: 'Desactivar cliente', en: 'Deactivate client' }) }}
        </button>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="confirmOpen"
      :title="label({ es: 'Desactivar cliente', en: 'Deactivate client' })"
      :body="label({ es: `Desactivar a ${pendingDeactivateName}: no va a poder iniciar sesión ni ser asignado a nuevos turnos. ¿Confirmás?`, en: `Deactivate ${pendingDeactivateName}: they won't be able to log in or be assigned to new appointments. Confirm?` })"
      :confirm-label="label({ es: 'Desactivar', en: 'Deactivate' })"
      :destructive="true"
      @confirm="confirmDeactivate"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
