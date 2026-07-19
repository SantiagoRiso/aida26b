<script setup lang="ts">
// This-and-future / whole-series reschedule: only the date/time move (splitSeriesFuture and
// updateSeries only ever touch start_time + weekday for a plain reschedule) — no client/professional/
// service pickers, no conflict recheck (neither endpoint conflict-checks). Reuses the same date/time
// input components AppointmentForm's own reschedule mode uses.
import { reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Appointment } from '@/api/appointments';
import { localDateTime } from '@/composables/bookingForm';
import AppButton from '@/components/shared/AppButton.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';

const props = defineProps<{
  appointment: Appointment;
}>();

const emit = defineEmits<{
  submit: [date: string, start: string];
  cancel: [];
}>();

const { t } = useI18n();

const apptStart = localDateTime(props.appointment.starts_at);
const form = reactive({ date: apptStart.date, start: apptStart.time });

function submit() {
  emit('submit', form.date, form.start);
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="submit">
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="series-reschedule-date">{{ t('calendar.dateLabel') }} *</label>
      <DateField id="series-reschedule-date" v-model="form.date" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="series-reschedule-start">{{ t('calendar.timeLabel') }} *</label>
      <TimeField id="series-reschedule-start" v-model="form.start" />
    </div>

    <div class="flex gap-2 pt-2">
      <AppButton type="submit" variant="primary">
        {{ t('actions.save') }}
      </AppButton>
      <AppButton type="button" variant="neutral" @click="emit('cancel')">
        {{ t('actions.cancel') }}
      </AppButton>
    </div>
  </form>
</template>
