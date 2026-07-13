<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { useToast } from '@/composables/useToast';
import { listClosures, createClosure, updateClosure, deleteClosure, type BusinessClosure } from '@/api/closures';
import { useTimeOffConflictGate, shortDate } from '@/composables/useTimeOffConflictGate';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const { label } = useLabel();
const { success, error: toastError } = useToast();
const gate = useTimeOffConflictGate();

interface ClosureFields { date: string; start: string; end: string; reason: string }

const rows = ref<BusinessClosure[]>([]);
const loading = ref(false);
const deleteTarget = ref<BusinessClosure | null>(null);

// The bottom "add a holiday" form.
const form = reactive<ClosureFields>({ date: '', start: '', end: '', reason: '' });
const saving = ref(false);
const formError = ref('');

// Inline edit of a single row — its own state so it never touches the add form.
const editingId = ref<string | null>(null);
const editForm = reactive<ClosureFields>({ date: '', start: '', end: '', reason: '' });
const editSaving = ref(false);
const editError = ref('');

function startEdit(c: BusinessClosure) {
  editingId.value = c.id;
  editForm.date = c.exception_date;
  editForm.start = c.start_time ?? '';
  editForm.end = c.end_time ?? '';
  editForm.reason = c.reason ?? '';
  editError.value = '';
}

function cancelEdit() {
  editingId.value = null;
  editError.value = '';
}

async function load() {
  loading.value = true;
  const res = await listClosures();
  loading.value = false;
  if (res.ok) rows.value = res.data;
}
onMounted(load);

function validate(v: ClosureFields): string | null {
  if (!v.date) return label({ es: 'Seleccionar una fecha.', en: 'Select a date.' });
  // A time range needs both endpoints or neither, matching the server rule.
  if (!!v.start !== !!v.end) {
    return label({ es: 'Completar desde y hasta, o dejar ambos vacíos.', en: 'Fill both from and to, or leave both empty.' });
  }
  return null;
}

// A closure that collides with booked turnos warns first — it leaves them in conflict (computed,
// reversible), it never cancels them. Shared by add and edit.
function confirmClosure(v: ClosureFields): Promise<boolean> {
  return gate.confirmTimeOff(
    { date: v.date, start: v.start || null, end: v.end || null },
    (n) => label({
      es: `Va a dejar ${n} turno${n === 1 ? '' : 's'} en conflicto el ${shortDate(v.date)}. ¿Continuar?`,
      en: `This will leave ${n} appointment${n === 1 ? '' : 's'} in conflict on ${shortDate(v.date)}. Continue?`,
    }),
  );
}

function bodyOf(v: ClosureFields) {
  return { exception_date: v.date, start_time: v.start || null, end_time: v.end || null, reason: v.reason || null };
}

const saveFailed = () => label({ es: 'No se pudo guardar el día festivo.', en: 'Could not save the holiday.' });

async function submitAdd() {
  const err = validate(form);
  if (err) { formError.value = err; return; }
  formError.value = '';
  if (!(await confirmClosure(form))) return;

  saving.value = true;
  const res = await createClosure(bodyOf(form));
  saving.value = false;
  if (res.ok) {
    success('saved');
    form.date = ''; form.start = ''; form.end = ''; form.reason = '';
    await load();
  } else {
    formError.value = res.message ?? saveFailed();
  }
}

async function submitEdit() {
  if (editingId.value == null) return;
  const err = validate(editForm);
  if (err) { editError.value = err; return; }
  editError.value = '';
  if (!(await confirmClosure(editForm))) return;

  editSaving.value = true;
  const res = await updateClosure(editingId.value, bodyOf(editForm));
  editSaving.value = false;
  if (res.ok) {
    success('saved');
    editingId.value = null;
    await load();
  } else {
    editError.value = res.message ?? saveFailed();
  }
}

async function confirmDelete() {
  const row = deleteTarget.value;
  deleteTarget.value = null;
  if (!row) return;
  const res = await deleteClosure(row.id);
  if (res.ok) { success('saved'); await load(); }
  else toastError('genericError');
}

function rangeLabel(c: BusinessClosure): string {
  return c.start_time && c.end_time
    ? `${c.start_time}–${c.end_time}`
    : label({ es: 'Todo el día', en: 'All day' });
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="text-sm text-neutral">…</div>
    <p v-else-if="rows.length === 0" class="text-sm text-neutral">
      {{ label({ es: 'No hay días festivos.', en: 'No holidays yet.' }) }}
    </p>
    <ul v-else class="space-y-2">
      <li
        v-for="c in rows"
        :key="c.id"
        class="rounded-md border border-border px-3 py-2"
      >
        <!-- Inline edit in place — no jumping to a form at the foot of the list. -->
        <div v-if="editingId === c.id" class="space-y-2">
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-neutral">{{ label({ es: 'Fecha', en: 'Date' }) }}</span>
              <DateField v-model="editForm.date" />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-neutral">{{ label({ es: 'Desde (opcional)', en: 'From (optional)' }) }}</span>
              <TimeField v-model="editForm.start" />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-medium text-neutral">{{ label({ es: 'Hasta (opcional)', en: 'To (optional)' }) }}</span>
              <TimeField v-model="editForm.end" />
            </label>
            <label class="flex min-w-[160px] flex-1 flex-col gap-1 text-sm">
              <span class="font-medium text-neutral">{{ label({ es: 'Motivo (opcional)', en: 'Reason (optional)' }) }}</span>
              <input v-model="editForm.reason" type="text" class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </label>
            <AppButton variant="primary" :loading="editSaving" @click="submitEdit">
              {{ label({ es: 'Guardar cambios', en: 'Save changes' }) }}
            </AppButton>
            <AppButton variant="neutral" @click="cancelEdit">
              {{ label({ es: 'Cancelar', en: 'Cancel' }) }}
            </AppButton>
          </div>
          <FieldError :message="editError" />
        </div>

        <div v-else class="flex items-center justify-between gap-3">
          <span class="flex flex-wrap items-center gap-2 text-sm">
            <span class="font-medium tabular-nums">{{ c.exception_date }}</span>
            <span class="rounded bg-surface px-2 py-0.5 text-xs text-neutral">{{ rangeLabel(c) }}</span>
            <span v-if="c.reason" class="text-neutral">{{ c.reason }}</span>
          </span>
          <span class="flex items-center gap-2">
            <AppButton variant="neutral" @click="startEdit(c)">
              {{ label({ es: 'Editar', en: 'Edit' }) }}
            </AppButton>
            <AppButton variant="destructive" @click="deleteTarget = c">
              {{ label({ es: 'Quitar', en: 'Remove' }) }}
            </AppButton>
          </span>
        </div>
      </li>
    </ul>

    <div class="flex flex-wrap items-end gap-3 border-t border-border pt-4">
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ label({ es: 'Fecha', en: 'Date' }) }}</span>
        <DateField v-model="form.date" />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ label({ es: 'Desde (opcional)', en: 'From (optional)' }) }}</span>
        <TimeField v-model="form.start" />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ label({ es: 'Hasta (opcional)', en: 'To (optional)' }) }}</span>
        <TimeField v-model="form.end" />
      </label>
      <label class="flex min-w-[160px] flex-1 flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ label({ es: 'Motivo (opcional)', en: 'Reason (optional)' }) }}</span>
        <input v-model="form.reason" type="text" class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </label>
      <AppButton variant="primary" :loading="saving" @click="submitAdd">
        {{ label({ es: 'Agregar día festivo', en: 'Add holiday' }) }}
      </AppButton>
    </div>
    <FieldError :message="formError" />

    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="label({ es: 'Quitar día festivo', en: 'Remove holiday' })"
      :body="label({ es: '¿Quitar este día festivo?', en: 'Remove this holiday?' })"
      :confirm-label="label({ es: 'Quitar', en: 'Remove' })"
      destructive
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />

    <ConfirmDialog
      :open="gate.open.value"
      :title="label({ es: 'Día festivo', en: 'Holiday' })"
      :body="gate.message.value"
      :confirm-label="label({ es: 'Continuar', en: 'Continue' })"
      @confirm="gate.onConfirm"
      @cancel="gate.onCancel"
    />
  </div>
</template>
