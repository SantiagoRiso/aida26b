<script setup lang="ts">
import { ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { deleteRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import type { TableRecordMap } from '@shared/types/types';
import GenericTable from '@/components/generic/GenericTable.vue';
import GenericForm from '@/components/generic/GenericForm.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import ScheduleBlockEditor from '@/components/schedule/ScheduleBlockEditor.vue';

const { label } = useLabel();
const { toast } = useToast();

const TABLE_KEY = 'resources' as const;

const panelOpen = ref(false);
const editingRow = ref<TableRecordMap['resources'] | null>(null);
const mode = ref<'create' | 'edit'>('create');
const confirmOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);
const reloadKey = ref(0);
const scheduleOpen = ref(false);
const scheduleResourceId = ref<number | null>(null);

function onEdit(row: TableRecordMap['resources']) {
  editingRow.value = row;
  mode.value = 'edit';
  panelOpen.value = true;
}

function openSchedule(row: TableRecordMap['resources']) {
  const id = Number(row.id);
  if (!Number.isFinite(id)) return;
  scheduleResourceId.value = id;
  scheduleOpen.value = true;
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

function requestDelete(row: TableRecordMap['resources']) {
  pendingDeleteId.value = String(row.id);
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
    >
      <template #row-actions="{ row }">
        <button
          type="button"
          class="mr-2 text-accent hover:underline text-xs"
          @click.stop="openSchedule(row)"
        >
          {{ label({ es: 'Horario', en: 'Schedule' }) }}
        </button>
      </template>
    </GenericTable>

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

    <DetailPanel
      :open="scheduleOpen"
      size="7xl"
      :title="label({ es: 'Horario del recurso', en: 'Resource schedule' })"
      @close="scheduleOpen = false"
      @after-leave="scheduleResourceId = null"
    >
      <ScheduleBlockEditor
        v-if="scheduleResourceId !== null"
        :owner="{ kind: 'resource', id: scheduleResourceId }"
      />
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
