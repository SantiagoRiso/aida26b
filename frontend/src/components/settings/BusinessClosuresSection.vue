<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from '@/composables/useToast';
import { listClosures, createClosure, updateClosure, deleteClosure, type BusinessClosure } from '@/api/closures';
import { useTimeOffConflictGate } from '@/composables/useTimeOffConflictGate';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

const { t } = useI18n();
const { success, error: toastError } = useToast();
const gate = useTimeOffConflictGate();

// allDay collapses the closure to a full-day one (start/end null); unchecking reveals the range.
interface ClosureFields { date: string; start: string; end: string; reason: string; allDay: boolean }

const rows = ref<BusinessClosure[]>([]);
const loading = ref(false);
const deleteTarget = ref<BusinessClosure | null>(null);

const form = reactive<ClosureFields>({ date: '', start: '', end: '', reason: '', allDay: true });
const saving = ref(false);
const formError = ref('');

// Inline edit of a single row — its own state so it never touches the add form.
const editingId = ref<string | null>(null);
const editForm = reactive<ClosureFields>({ date: '', start: '', end: '', reason: '', allDay: true });
const editSaving = ref(false);
const editError = ref('');

function startEdit(c: BusinessClosure) {
  editingId.value = c.id;
  editForm.date = c.exception_date;
  editForm.start = c.start_time ?? '';
  editForm.end = c.end_time ?? '';
  editForm.reason = c.reason ?? '';
  editForm.allDay = !(c.start_time && c.end_time);
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
  if (!v.date) return t('closures.selectDate');
  // A partial-day closure needs both endpoints; a full day carries neither.
  if (!v.allDay && (!v.start || !v.end)) {
    return t('closures.fillRange');
  }
  return null;
}

// A full-day closure carries no times; otherwise the typed range (blank endpoints normalize to null).
function effectiveTimes(v: ClosureFields): { start: string | null; end: string | null } {
  return v.allDay ? { start: null, end: null } : { start: v.start || null, end: v.end || null };
}

// A closure that collides with booked turnos warns first — it leaves them in conflict (computed,
// reversible), it never cancels them. Shared by add and edit.
function confirmClosure(v: ClosureFields): Promise<boolean> {
  const { start, end } = effectiveTimes(v);
  return gate.confirmTimeOff({ date: v.date, start, end });
}

function bodyOf(v: ClosureFields) {
  const { start, end } = effectiveTimes(v);
  return { exception_date: v.date, start_time: start, end_time: end, reason: v.reason || null };
}

const saveFailed = () => t('closures.saveFailed');

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
    form.date = ''; form.start = ''; form.end = ''; form.reason = ''; form.allDay = true;
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
    ? `${c.start_time}-${c.end_time}`
    : t('closures.allDay');
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="text-sm text-neutral">…</div>
    <p v-else-if="rows.length === 0" class="text-sm text-neutral">
      {{ t('closures.empty') }}
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
              <span class="font-medium text-neutral">{{ t('calendar.dateLabel') }}</span>
              <DateField v-model="editForm.date" />
            </label>
            <label class="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" v-model="editForm.allDay" class="h-4 w-4 accent-accent" data-testid="closure-edit-allday" />
              <span class="font-medium text-neutral">{{ t('closures.allDay') }}</span>
            </label>
            <template v-if="!editForm.allDay">
              <label class="flex flex-col gap-1 text-sm">
                <span class="font-medium text-neutral">{{ t('generic.from') }}</span>
                <TimeField v-model="editForm.start" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                <span class="font-medium text-neutral">{{ t('generic.to') }}</span>
                <TimeField v-model="editForm.end" />
              </label>
            </template>
            <label class="flex min-w-[160px] flex-1 flex-col gap-1 text-sm">
              <span class="font-medium text-neutral">{{ t('fields.reasonOptional') }}</span>
              <input v-model="editForm.reason" type="text" class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
            </label>
            <AppButton variant="primary" :loading="editSaving" @click="submitEdit">
              {{ t('actions.saveChanges') }}
            </AppButton>
            <AppButton variant="neutral" @click="cancelEdit">
              {{ t('actions.cancel') }}
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
              {{ t('actions.edit') }}
            </AppButton>
            <AppButton variant="destructive" @click="deleteTarget = c">
              {{ t('closures.remove') }}
            </AppButton>
          </span>
        </div>
      </li>
    </ul>

    <div class="flex flex-wrap items-end gap-3 border-t border-border pt-4">
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ t('calendar.dateLabel') }}</span>
        <DateField v-model="form.date" />
      </label>
      <label class="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" v-model="form.allDay" class="h-4 w-4 accent-accent" data-testid="closure-add-allday" />
        <span class="font-medium text-neutral">{{ t('closures.allDay') }}</span>
      </label>
      <template v-if="!form.allDay">
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium text-neutral">{{ t('generic.from') }}</span>
          <TimeField v-model="form.start" />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-medium text-neutral">{{ t('generic.to') }}</span>
          <TimeField v-model="form.end" />
        </label>
      </template>
      <label class="flex min-w-[160px] flex-1 flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ t('fields.reasonOptional') }}</span>
        <input v-model="form.reason" type="text" class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </label>
      <AppButton variant="primary" :loading="saving" data-testid="closure-add-submit" @click="submitAdd">
        {{ t('closures.addHoliday') }}
      </AppButton>
    </div>
    <FieldError :message="formError" />

    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="t('closures.removeTitle')"
      :body="t('closures.removeBody')"
      :confirm-label="t('closures.remove')"
      destructive
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />

    <ConfirmDialog
      :open="gate.open.value"
      :title="t('closures.dialogTitle')"
      :body="gate.message.value"
      :confirm-label="t('actions.continue')"
      @confirm="gate.onConfirm"
      @cancel="gate.onCancel"
    />
  </div>
</template>
