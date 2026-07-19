<script setup lang="ts">
// The recurrence-rule fields (frequency/interval/weekday/week_of_month/day_of_month/end) — shared
// by AppointmentForm's create-time "Repetir" toggle and the series rule editor (whole-series /
// this-and-future edits). `recurrence` is the caller's own reactive object; fields are written
// directly onto it (same pattern the fields used inline in AppointmentForm before extraction).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Selector from '@/components/shared/Selector.vue';
import FieldError from '@/components/shared/FieldError.vue';
import DateField from '@/components/shared/DateField.vue';
import { WEEKDAY_OPTIONS } from '@shared/ssot/domain/availability';
import { isEndKind, isFrequency } from '@shared/ssot/domain/recurrence';
import { structure } from '@shared/ssot/structure';
import { useLabel } from '@/composables/useLabel';
import { recurrenceShape, type RecurrenceState } from '@/composables/seriesRule';

const props = defineProps<{
  recurrence: RecurrenceState;
  fieldErrors: Record<string, string>;
  // end_date must be on/after the rule's own start (mirrors validateSeriesRuleShape).
  minEndDate?: string | null;
}>();

const emit = defineEmits<{
  // Fired when the user explicitly picks a weekday — callers that auto-default the weekday from a
  // date field use this to stop clobbering a deliberate choice.
  'weekday-picked': [];
}>();

const { t } = useI18n();
const { label } = useLabel();
const seriesColumns = structure.tables.appointment_series.columns;

const frequencyOptions = computed(() =>
  seriesColumns.frequency.options.map((option) => ({ value: option.value, label: label(option.label) })),
);

const endKindOptions = computed(() =>
  seriesColumns.end_kind.options.map((option) => ({ value: option.value, label: label(option.label) })),
);

function selectFrequency(value: string | null): void {
  props.recurrence.frequency = isFrequency(value) ? value : 'weekly';
}

function selectEndKind(value: string | null): void {
  props.recurrence.end_kind = isEndKind(value) ? value : 'count';
}

const WEEK_OF_MONTH_LABEL_KEYS = [
  'calendar.weekFirst',
  'calendar.weekSecond',
  'calendar.weekThird',
  'calendar.weekFourth',
  'calendar.weekLast',
];
const weekOfMonthOptions = computed(() =>
  WEEK_OF_MONTH_LABEL_KEYS.map((key, i) => ({ value: String(i + 1), label: t(key) })),
);

const weekdayOptions = computed(() => WEEKDAY_OPTIONS.map((o) => ({ value: o.value, label: label(o.label) })));

const showsWeekday = computed(() => recurrenceShape(props.recurrence).showsWeekday);
const showsWeekOfMonth = computed(() => recurrenceShape(props.recurrence).showsWeekOfMonth);
const showsDayOfMonth = computed(() => recurrenceShape(props.recurrence).showsDayOfMonth);
</script>

<template>
  <div class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-frequency">{{ label(seriesColumns.frequency.label) }}</label>
    <Selector
      id="appt-frequency"
      :model-value="recurrence.frequency"
      :label-if-single="false"
      :show-empty-option="false"
      :options="frequencyOptions"
      @update:model-value="selectFrequency"
    />
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-interval">{{ t('calendar.recurrenceInterval') }}</label>
    <input
      id="appt-interval"
      v-model="recurrence.interval"
      type="number"
      min="1"
      class="rounded border border-border px-3 py-2 text-sm"
    />
    <FieldError :message="fieldErrors.interval" />
  </div>

  <div v-if="showsWeekday" class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-weekday">{{ label(seriesColumns.weekday.label) }}</label>
    <Selector
      id="appt-weekday"
      :model-value="recurrence.weekday || null"
      :label-if-single="false"
      :show-empty-option="false"
      :options="weekdayOptions"
      @update:model-value="(v) => { recurrence.weekday = v ?? ''; emit('weekday-picked') }"
    />
    <FieldError :message="fieldErrors.weekday" />
  </div>

  <div v-if="showsWeekOfMonth" class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-week-of-month">
      {{ label(seriesColumns.week_of_month.label) }}
    </label>
    <Selector
      id="appt-week-of-month"
      :model-value="recurrence.week_of_month || null"
      :label-if-single="false"
      :show-empty-option="false"
      :options="weekOfMonthOptions"
      @update:model-value="(v) => { recurrence.week_of_month = v ?? '' }"
    />
    <FieldError :message="fieldErrors.week_of_month" />
  </div>

  <div v-if="showsDayOfMonth" class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-day-of-month">
      {{ label(seriesColumns.day_of_month.label) }}
    </label>
    <input
      id="appt-day-of-month"
      v-model="recurrence.day_of_month"
      type="number"
      min="1"
      max="31"
      class="rounded border border-border px-3 py-2 text-sm"
    />
    <FieldError :message="fieldErrors.day_of_month" />
  </div>

  <div class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-end-kind">{{ label(seriesColumns.end_kind.label) }}</label>
    <Selector
      id="appt-end-kind"
      :model-value="recurrence.end_kind"
      :label-if-single="false"
      :show-empty-option="false"
      :options="endKindOptions"
      @update:model-value="selectEndKind"
    />
  </div>

  <div v-if="recurrence.end_kind === 'count'" class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-end-count">{{ label(seriesColumns.end_count.label) }}</label>
    <input
      id="appt-end-count"
      v-model="recurrence.end_count"
      type="number"
      min="1"
      class="rounded border border-border px-3 py-2 text-sm"
    />
    <FieldError :message="fieldErrors.end_count" />
  </div>

  <div v-if="recurrence.end_kind === 'until'" class="flex flex-col gap-1">
    <label class="text-sm font-semibold" for="appt-end-date">{{ label(seriesColumns.end_date.label) }}</label>
    <DateField
      id="appt-end-date"
      v-model="recurrence.end_date"
      :invalid="!!fieldErrors.end_date"
      :min="minEndDate ?? null"
    />
    <FieldError :message="fieldErrors.end_date" />
  </div>
</template>
