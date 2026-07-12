<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { createRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import { buildExceptionBody, type ExceptionKind } from '@/composables/scheduleExceptions';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import DateField from '@/components/shared/DateField.vue';
import type { ColumnValue, TableRecordMap } from '@shared/types/types';

const props = defineProps<{
  prefillDate?: string;
  professionalId?: number | null;
  resourceId?: number | null;
}>();

const emit = defineEmits<{
  saved: [];
  cancel: [];
}>();

const { t } = useI18n();
const toast = useToast();

interface FormState {
  kind: ExceptionKind;
  date: string;
  start_time: string;
  end_time: string;
  granularity_minutes: string;
  reason: string;
}

const form = reactive<FormState>({
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

  saving.value = true;
  const result = await createRow(
    'schedule_exceptions',
    built.body as Record<string, ColumnValue | undefined> as Partial<TableRecordMap['schedule_exceptions']>,
  );
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
      <select id="exc-kind" v-model="form.kind" class="rounded border border-border px-3 py-2 text-sm">
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
        <input id="exc-start" v-model="form.start_time" type="time" class="rounded border border-border px-3 py-2 text-sm" />
      </div>
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="exc-end">{{ t('exception.endLabel') }} *</label>
        <input id="exc-end" v-model="form.end_time" type="time" class="rounded border border-border px-3 py-2 text-sm" />
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
        class="rounded border border-border px-3 py-2 text-sm"
      />
      <FieldError :message="fieldErrors.granularity_minutes" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="exc-reason">{{ t('exception.reasonLabel') }}</label>
      <textarea id="exc-reason" v-model="form.reason" rows="2" class="rounded border border-border px-3 py-2 text-sm" />
    </div>

    <div class="flex gap-2 pt-2">
      <AppButton type="submit" variant="primary" :loading="saving">
        {{ t('actions.save') }}
      </AppButton>
      <AppButton type="button" variant="neutral" @click="emit('cancel')">
        {{ t('actions.cancel') }}
      </AppButton>
    </div>
  </form>
</template>
