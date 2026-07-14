<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { useToast } from '@/composables/useToast';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import type { TableRecordMap } from '@shared/ssot/derived';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import ScheduleBlockEditor from '@/components/schedule/ScheduleBlockEditor.vue';

type Room = TableRecordMap['resources'];

const { label } = useLabel();
const { toast } = useToast();

const rooms = ref<Room[]>([]);
const loading = ref(false);

const adding = ref(false);
const newName = ref('');
const addError = ref('');
const savingAdd = ref(false);

const editingId = ref<string | null>(null);
const editName = ref('');
const editDescription = ref('');
const editError = ref('');
const savingEdit = ref(false);

const scheduleOpen = ref(false);
const scheduleResourceId = ref<number | null>(null);

const confirmOpen = ref(false);
const pendingDeleteId = ref<string | null>(null);

async function load() {
  loading.value = true;
  const res = await listRows('resources', { limit: 200 });
  loading.value = false;
  rooms.value = res.ok ? res.data : [];
}
onMounted(load);

function startAdd() {
  adding.value = true;
  newName.value = '';
  addError.value = '';
}

async function saveAdd() {
  addError.value = '';
  if (newName.value.trim() === '') {
    addError.value = label({ es: 'El nombre es obligatorio.', en: 'Name is required.' });
    return;
  }
  savingAdd.value = true;
  const res = await createRow('resources', { name: newName.value.trim() });
  savingAdd.value = false;
  if (res.ok) {
    adding.value = false;
    await load();
  } else {
    toast('error', 'genericError');
  }
}

function startEdit(room: Room) {
  editingId.value = String(room.id);
  editName.value = room.name;
  editDescription.value = room.description ?? '';
  editError.value = '';
}

async function saveEdit() {
  if (editingId.value == null) return;
  editError.value = '';
  if (editName.value.trim() === '') {
    editError.value = label({ es: 'El nombre es obligatorio.', en: 'Name is required.' });
    return;
  }
  savingEdit.value = true;
  const res = await updateRow('resources', editingId.value, {
    name: editName.value.trim(),
    description: editDescription.value.trim() === '' ? null : editDescription.value.trim(),
  });
  savingEdit.value = false;
  if (res.ok) {
    editingId.value = null;
    await load();
  } else {
    toast('error', 'genericError');
  }
}

function openSchedule(room: Room) {
  const id = Number(room.id);
  if (!Number.isFinite(id)) return;
  scheduleResourceId.value = id;
  scheduleOpen.value = true;
}

function requestDelete(room: Room) {
  pendingDeleteId.value = String(room.id);
  confirmOpen.value = true;
}

async function confirmDelete() {
  if (!pendingDeleteId.value) return;
  confirmOpen.value = false;
  const res = await deleteRow('resources', pendingDeleteId.value);
  if (res.ok) await load();
  else toast('error', 'genericError');
  pendingDeleteId.value = null;
}
</script>

<template>
  <div class="space-y-3">
    <p v-if="!loading && rooms.length === 0" class="text-sm text-neutral">
      {{ label({ es: 'No hay salas todavía.', en: 'No rooms yet.' }) }}
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="room in rooms"
        :key="String(room.id)"
        class="rounded-md border border-border px-3 py-2"
        :data-testid="`room-row-${room.id}`"
      >
        <div v-if="editingId === String(room.id)" class="space-y-2">
          <input
            v-model="editName"
            type="text"
            :placeholder="label({ es: 'Nombre', en: 'Name' })"
            :data-testid="`room-edit-name-${room.id}`"
            class="w-full rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <textarea
            v-model="editDescription"
            rows="2"
            :placeholder="label({ es: 'Descripción', en: 'Description' })"
            :data-testid="`room-edit-description-${room.id}`"
            class="w-full rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <FieldError :message="editError" />
          <div class="flex gap-2">
            <AppButton variant="primary" size="sm" :loading="savingEdit" :data-testid="`room-edit-save-${room.id}`" @click="saveEdit">
              {{ label({ es: 'Guardar', en: 'Save' }) }}
            </AppButton>
            <AppButton variant="neutral" size="sm" :data-testid="`room-edit-cancel-${room.id}`" @click="editingId = null">
              {{ label({ es: 'Cancelar', en: 'Cancel' }) }}
            </AppButton>
          </div>
        </div>

        <div v-else class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ room.name }}</p>
            <p v-if="room.description" class="truncate text-xs text-neutral">{{ room.description }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <AppButton variant="primary" size="sm" :data-testid="`room-schedule-${room.id}`" @click="openSchedule(room)">
              {{ label({ es: 'Horario', en: 'Schedule' }) }}
            </AppButton>
            <button
              type="button"
              class="text-xs text-accent hover:underline"
              :data-testid="`room-edit-${room.id}`"
              @click="startEdit(room)"
            >
              {{ label({ es: 'Editar', en: 'Edit' }) }}
            </button>
            <button
              type="button"
              class="text-xs text-destructive hover:underline"
              :data-testid="`room-delete-${room.id}`"
              @click="requestDelete(room)"
            >
              {{ label({ es: 'Eliminar', en: 'Delete' }) }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <div v-if="adding" class="flex flex-wrap items-start gap-2">
      <div class="flex flex-col gap-1">
        <input
          v-model="newName"
          type="text"
          :placeholder="label({ es: 'Nombre de la sala', en: 'Room name' })"
          data-testid="room-add-name"
          class="rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <FieldError :message="addError" />
      </div>
      <AppButton variant="primary" size="sm" :loading="savingAdd" data-testid="room-add-save" @click="saveAdd">
        {{ label({ es: 'Agregar', en: 'Add' }) }}
      </AppButton>
      <AppButton variant="neutral" size="sm" data-testid="room-add-cancel" @click="adding = false">
        {{ label({ es: 'Cancelar', en: 'Cancel' }) }}
      </AppButton>
    </div>
    <button
      v-else
      type="button"
      class="text-sm text-accent hover:underline"
      data-testid="room-add-start"
      @click="startAdd"
    >
      {{ label({ es: '＋ Agregar sala', en: '＋ Add room' }) }}
    </button>

    <DetailPanel
      :open="scheduleOpen"
      size="7xl"
      :title="label({ es: 'Horario de la sala', en: 'Room schedule' })"
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
      :title="label({ es: 'Eliminar sala', en: 'Delete room' })"
      :body="label({ es: 'Esta acción no se puede deshacer.', en: 'This action cannot be undone.' })"
      :confirm-label="label({ es: 'Eliminar', en: 'Delete' })"
      :destructive="true"
      @confirm="confirmDelete"
      @cancel="confirmOpen = false"
    />
  </div>
</template>
