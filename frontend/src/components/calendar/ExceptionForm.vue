<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { createRow, updateRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import { useTimeOffConflictGate } from '@/composables/useTimeOffConflictGate';
import { buildExceptionBody, classifyException, type ExceptionKind, type ExceptionRow } from '@/composables/scheduleExceptions';
import AppButton from '@/components/shared/AppButton.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import FieldError from '@/components/shared/FieldError.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';

const props = defineProps<{
  prefillDate?: string;
  professionalId?: number | null;
  resourceId?: number | null;
  // When set, the form edits this existing row (updateRow) instead of creating a new one.
  exception?: ExceptionRow;
}>();

const emit = defineEmits<{
  saved: [];
  cancel: [];
}>();

const { t } = useI18n();
const toast = useToast();
const gate = useTimeOffConflictGate();

interface FormState {
  kind: ExceptionKind;
  date: string;
  start_time: string;
  end_time: string;
  granularity_minutes: string;
  reason: string;
}

// Editing reconstructs the form's kind + fields from the stored row; otherwise a blank 'off' form.
// Parent re-mounts (keyed) when the edited row changes, so setup-time init is enough.
const form = reactive<FormState>(props.exception
  ? {
      kind: classifyException(props.exception),
      date: props.exception.exception_date,
      start_time: props.exception.start_time?.slice(0, 5) ?? '',
      end_time: props.exception.end_time?.slice(0, 5) ?? '',
      granularity_minutes: props.exception.granularity_minutes != null ? String(props.exception.granularity_minutes) : '',
      reason: props.exception.reason ?? '',
    }
  : {
      kind: 'off',
      date: props.prefillDate ?? '',
      start_time: '',
      end_time: '',
      granularity_minutes: '',
      reason: '',
    });

const fieldErrors = ref<Record<string, string>>({});
const saving = ref(false);

async function submit() {
  fieldErrors.value = {};

  const built = buildExceptionBody({
    kind: form.kind,
    owner: { professional_user_id: props.professionalId ?? null, resource_id: props.resourceId ?? null },
    date: form.date,
    start_time: form.kind === 'off' ? null : form.start_time || null,
    end_time: form.kind === 'off' ? null : form.end_time || null,
    granularity_minutes: form.kind === 'extra' ? (form.granularity_minutes ? Number(form.granularity_minutes) : null) : null,
    reason: form.reason || null,
  });

  if (!built.ok) {
    if (built.reason === 'owner') {
      toast.error('exceptionMissingOwner');
      fieldErrors.value.owner = t('toast.exceptionMissingOwner');
    } else if (built.reason === 'granularity') {
      toast.error('exceptionMissingGranularity');
      fieldErrors.value.granularity_minutes = t('toast.exceptionMissingGranularity');
    } else {
      toast.error('exceptionInvalidRange');
      fieldErrors.value.end_time = t('toast.exceptionInvalidRange');
    }
    return;
  }

  // Blocking time off (full-day 'off' or a partial 'block') for a professional may collide with
  // their booked turnos — warn first. 'extra' adds hours (never conflicts) and resources are out of
  // scope for turno conflicts, so both skip the gate.
  if (props.professionalId != null && (form.kind === 'off' || form.kind === 'block')) {
    const proceed = await gate.confirmTimeOff({
      date: form.date,
      professional_user_id: props.professionalId,
      start: form.kind === 'block' ? form.start_time || null : null,
      end: form.kind === 'block' ? form.end_time || null : null,
    });
    if (!proceed) return;
  }

  saving.value = true;
  const result = props.exception
    ? await updateRow('schedule_exceptions', props.exception.id, built.body)
    : await createRow('schedule_exceptions', built.body);
  saving.value = false;

  if (!result.ok) {
    toast.error('exceptionSaveError');
    if (result.fields) {
      fieldErrors.value = { ...fieldErrors.value, ...result.fields };
    }
    return;
  }

  emit('saved');
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="submit">
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="exc-kind">{{ t('exception.kindLabel') }} *</label>
      <select id="exc-kind" v-model="form.kind" class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
        <option value="off">{{ t('exception.kind.off') }}</option>
        <option value="block">{{ t('exception.kind.block') }}</option>
        <option value="extra">{{ t('exception.kind.extra') }}</option>
      </select>
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="exc-date">{{ t('exception.dateLabel') }} *</label>
      <DateField id="exc-date" v-model="form.date" />
      <FieldError :message="fieldErrors.owner" />
    </div>

    <div v-if="form.kind !== 'off'" class="flex gap-3">
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="exc-start">{{ t('exception.startLabel') }} *</label>
        <TimeField id="exc-start" v-model="form.start_time" />
      </div>
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="exc-end">{{ t('exception.endLabel') }} *</label>
        <TimeField id="exc-end" v-model="form.end_time" />
        <FieldError :message="fieldErrors.end_time" />
      </div>
    </div>

    <div v-if="form.kind === 'extra'" class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="exc-granularity">{{ t('exception.granularityLabel') }} *</label>
      <input
        id="exc-granularity"
        v-model="form.granularity_minutes"
        type="number"
        min="1"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <FieldError :message="fieldErrors.granularity_minutes" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="exc-reason">{{ t('exception.reasonLabel') }}</label>
      <textarea id="exc-reason" v-model="form.reason" rows="2" class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
    </div>

    <div class="flex gap-2 pt-2">
      <AppButton type="submit" variant="primary" :loading="saving">
        {{ exception ? t('actions.saveChanges') : t('actions.save') }}
      </AppButton>
      <AppButton type="button" variant="neutral" @click="emit('cancel')">
        {{ t('actions.cancel') }}
      </AppButton>
    </div>

    <ConfirmDialog
      :open="gate.open.value"
      :title="t('exception.addButton')"
      :body="gate.message.value"
      :confirm-label="t('actions.continue')"
      @confirm="gate.onConfirm"
      @cancel="gate.onCancel"
    />
  </form>
</template>
