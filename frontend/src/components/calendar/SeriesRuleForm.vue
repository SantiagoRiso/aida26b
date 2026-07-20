<script setup lang="ts">
// "Editar serie" — the whole-series/this-and-future recurrence rule editor. Reuses the same
// Repetir fields AppointmentForm uses at create time, prefilled from the fetched series; on save it
// hands the built patch to the caller, which drives the this-and-future/whole-series scope choice
// (only those two scopes make sense for a rule edit — there is no "this occurrence only" recurrence).
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppointmentSeries, ScheduleSeriesBody } from '@/api/appointments';
import AppButton from '@/components/shared/AppButton.vue';
import RecurrenceRuleFields from './RecurrenceRuleFields.vue';
import {
  recurrenceStateFromSeries,
  validateRecurrenceFields,
  buildRulePatch,
} from '@/composables/seriesRule';

const props = defineProps<{
  series: AppointmentSeries;
}>();

const emit = defineEmits<{
  saved: [patch: Partial<ScheduleSeriesBody>];
  cancel: [];
}>();

const { t } = useI18n();

const recurrence = reactive(recurrenceStateFromSeries(props.series));
const fieldErrors = ref<Record<string, string>>({});

function submit() {
  const errors = validateRecurrenceFields(recurrence);
  if (Object.keys(errors).length > 0) {
    fieldErrors.value = errors;
    return;
  }
  fieldErrors.value = {};
  emit('saved', buildRulePatch(recurrence));
}
</script>

<template>
  <form class="grid grid-cols-1 gap-4 sm:grid-cols-2" @submit.prevent="submit">
    <RecurrenceRuleFields
      :recurrence="recurrence"
      :field-errors="fieldErrors"
      :min-end-date="series.start_date"
    />

    <div class="flex gap-2 pt-2 sm:col-span-2">
      <AppButton type="submit" variant="primary">
        {{ t('actions.save') }}
      </AppButton>
      <AppButton type="button" variant="neutral" @click="emit('cancel')">
        {{ t('actions.cancel') }}
      </AppButton>
    </div>
  </form>
</template>
