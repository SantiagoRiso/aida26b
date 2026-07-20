<script setup lang="ts">
// Conflict check happens ON SAVE only — no live preview.
// On requires_override the parent receives the verdict and handles the override dialog.

import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { scheduleAppointment, rescheduleAppointment, scheduleSeries } from '@/api/appointments';
import type { Appointment, ScheduleBody, ScheduleSeriesBody, ScheduleSeriesResult, SeriesSkip } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { useBookingOptions } from '@/composables/useBookingOptions';
import { useToast } from '@/composables/useToast';
import { fieldErrorMessages } from '@/i18n/api-errors';
import { useConflictVerdict } from '@/composables/useConflictVerdict';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import Selector from '@/components/shared/Selector.vue';
import SlotPicker from './SlotPicker.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/20/solid';
import { isoDate, addDaysISO, intervalMinutes, localDateTime } from '@/composables/bookingForm';
import { useBookingWindow } from '@/composables/useBookingWindow';
import type { TimeInterval } from '@shared/ssot/domain/availability';
import { isWeekday, weekdayOf } from '@shared/ssot/domain/availability';
import { structure } from '@shared/ssot/structure';
import { useLabel } from '@/composables/useLabel';
import RecurrenceRuleFields from './RecurrenceRuleFields.vue';
import {
  defaultRecurrenceState,
  recurrenceShape,
  validateRecurrenceFields,
  type RecurrenceState,
} from '@/composables/seriesRule';

const props = defineProps<{
  appointment?: Appointment;
  prefillDate?: string;
  prefillStart?: string;
  prefillProfessionalId?: number;
  prefillResourceId?: number;
  // Booking for a specific client (e.g. from the client detail page) — locks the client field.
  prefillClientId?: number;
  // Opened from a sobreturno (off-lattice) calendar click — start in manual hora/duración mode so the
  // clicked time is bookable without a matching published slot.
  prefillSobreturno?: boolean;
  // Duration to seed a sobreturno with — the effective duration of the service offered by the block
  // nearest the clicked time, so the manual field starts at a sensible value.
  prefillDuration?: number;
}>();

const emit = defineEmits<{
  (e: 'saved', appt: Appointment): void;
  (e: 'conflictDetected', verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18n();
const { label } = useLabel();
const toast = useToast();
const { describe: describeConflictVerdict } = useConflictVerdict();
const appointmentColumns = structure.tables.appointments.columns;

interface FormState {
  client_user_id: string;
  professional_user_id: string;
  service_id: string;
  resource_id: string;
  date: string;
  start: string;
  duration_minutes: string;
  name: string;
  description: string;
}

const apptStart = props.appointment ? localDateTime(props.appointment.starts_at) : null;

const form = reactive<FormState>({
  client_user_id: String(props.prefillClientId ?? props.appointment?.client_user_id ?? ''),
  professional_user_id: String(props.prefillProfessionalId ?? props.appointment?.professional_user_id ?? ''),
  service_id: String(props.appointment?.service_id ?? ''),
  resource_id: String(props.prefillResourceId ?? props.appointment?.resource_id ?? ''),
  date: props.prefillDate ?? apptStart?.date ?? '',
  start: props.prefillStart ?? apptStart?.time ?? '',
  duration_minutes: String(props.appointment?.duration_minutes ?? props.prefillDuration ?? ''),
  name: props.appointment?.name ?? '',
  description: props.appointment?.description ?? '',
});

const todayISO = isoDate(new Date());

// New bookings are bounded by the effective booking window (same as the client portal); a reschedule
// edits around an existing (possibly out-of-window) date, so the clamp applies to the create flow only.
const { windowMax, minDate } = useBookingWindow(
  computed(() => (form.professional_user_id ? Number(form.professional_user_id) : null)),
  computed(() => (form.service_id ? Number(form.service_id) : null)),
);

function stepDate(days: number): void {
  if (props.appointment) {
    form.date = addDaysISO(form.date || todayISO, days);
    return;
  }
  let next = addDaysISO(form.date || minDate.value, days);
  if (next < minDate.value) next = minDate.value;
  if (windowMax.value && next > windowMax.value) next = windowMax.value;
  form.date = next;
}
const atMinDate = computed(() => !props.appointment && (form.date || minDate.value) <= minDate.value);
const atMaxDate = computed(
  () => !props.appointment && windowMax.value != null && (form.date || minDate.value) >= windowMax.value,
);

const fieldErrors = ref<Record<string, string>>({});
const saving = ref(false);

// Hora/duración are normally derived from the picked slot; the sobreturno checkbox switches to manual
// entry (booking outside published availability). Reschedule and a sobreturno calendar click open it
// checked — a reschedule edits the time directly, and a sobreturno's time is off the lattice so there
// is no slot to pick.
const sobreturno = ref(!!props.appointment || !!props.prefillSobreturno);

const {
  clientOptions,
  professionalOptions: availableProfessionalOptions,
  availableServiceOptions,
} = useBookingOptions({
  withClients: true,
  selectedProfessionalId: () => form.professional_user_id || null,
});

// Locked when booking from a specific client's page — the client isn't a choice here.
const clientLocked = computed(() => props.prefillClientId != null);
const { options: resourceOptions } = useForeignKeyOptions({
  table: 'resources',
  valueField: 'id',
  labelField: 'name',
});

// No client-side duration prefill on service change: server-side resolveBooking is authoritative.
watch(() => form.service_id, () => {});

watch(
  availableProfessionalOptions,
  (opts) => {
    // Options load async; an empty list means "not loaded yet" — don't clobber a prefilled value.
    if (opts.length === 0) return;
    if (opts.length === 1) form.professional_user_id = opts[0].value;
    else if (!opts.some((o) => o.value === form.professional_user_id)) form.professional_user_id = '';
  },
  { immediate: true },
);

watch(
  availableServiceOptions,
  (opts) => {
    // Options load async; an empty list means "not loaded yet" — don't clobber a prefilled value.
    if (opts.length === 0) return;
    if (opts.length === 1) form.service_id = opts[0].value;
    else if (!opts.some((o) => o.value === form.service_id)) form.service_id = '';
  },
  { immediate: true },
);

function handleSlotSelected(slot: TimeInterval) {
  form.start = slot.start;
  form.duration_minutes = String(intervalMinutes(slot.start, slot.end));
}

function buildBody(override: boolean): ScheduleBody {
  return {
    client_user_id: form.client_user_id ? Number(form.client_user_id) : undefined,
    professional_user_id: Number(form.professional_user_id),
    service_id: Number(form.service_id),
    resource_id: form.resource_id ? Number(form.resource_id) : undefined,
    date: form.date,
    start: form.start,
    duration_minutes: Number(form.duration_minutes),
    name: form.name || undefined,
    description: form.description || undefined,
    override,
  };
}

// Reuses the same client/professional/service/resource/date/start/duration the single-create
// path already collects — only the recurrence shape (frequency/interval/end) is new state.
const recurrenceEnabled = ref(false);
const recurrence = reactive<RecurrenceState>(defaultRecurrenceState());
const seriesResult = ref<ScheduleSeriesResult | null>(null);

// Defaults the weekday to match the chosen date, but only until the user picks one explicitly —
// a manual pick is a deliberate choice, not something a later date edit should clobber.
const weekdayTouched = ref(false);
watch(
  () => form.date,
  (d) => {
    if (d && !weekdayTouched.value) recurrence.weekday = weekdayOf(d);
  },
  { immediate: true },
);

const showsWeekday = computed(() => recurrenceShape(recurrence).showsWeekday);
const showsWeekOfMonth = computed(() => recurrenceShape(recurrence).showsWeekOfMonth);
const showsDayOfMonth = computed(() => recurrenceShape(recurrence).showsDayOfMonth);

function buildSeriesBody(): ScheduleSeriesBody {
  return {
    client_user_id: Number(form.client_user_id),
    professional_user_id: Number(form.professional_user_id),
    service_id: Number(form.service_id),
    resource_id: form.resource_id ? Number(form.resource_id) : undefined,
    frequency: recurrence.frequency,
    interval: Number(recurrence.interval),
    weekday: showsWeekday.value && isWeekday(recurrence.weekday) ? recurrence.weekday : undefined,
    week_of_month: showsWeekOfMonth.value ? Number(recurrence.week_of_month) : undefined,
    day_of_month: showsDayOfMonth.value ? Number(recurrence.day_of_month) : undefined,
    start_time: form.start,
    start_date: form.date,
    duration_minutes: Number(form.duration_minutes),
    end_kind: recurrence.end_kind,
    end_count: recurrence.end_kind === 'count' ? Number(recurrence.end_count) : undefined,
    end_date: recurrence.end_kind === 'until' ? recurrence.end_date : undefined,
  };
}

// Minimal client-side check (required fields per frequency/end_kind, interval >= 1); the server
// re-validates authoritatively — this only avoids a round-trip for obviously incomplete input.
function validateRecurrence(): boolean {
  const errors = validateRecurrenceFields(recurrence);
  if (Object.keys(errors).length > 0) {
    fieldErrors.value = errors;
    return false;
  }
  return true;
}

// The API never builds display strings; reuse the same conflict→i18n mapping the override
// dialog uses so a skipped date's reasons read identically everywhere.
function describeSkip(skip: SeriesSkip): string[] {
  return describeConflictVerdict({
    conflicts: skip.conflicts,
    can_save: false,
    can_override: false,
    requires_override: false,
  }).lines;
}

async function save(override = false): Promise<void> {
  fieldErrors.value = {};

  if (recurrenceEnabled.value && !props.appointment) {
    if (!validateRecurrence()) return;
    saving.value = true;
    const result = await scheduleSeries(buildSeriesBody());
    saving.value = false;
    if (!result.ok) {
      toast.error('scheduleFailed');
      fieldErrors.value = fieldErrorMessages(result);
      return;
    }
    seriesResult.value = result.data;
    return;
  }

  // No client-side short-circuit on a missing client: the server must see the request so it
  // can return a conflict verdict first (warn-first) — only once no override is pending does
  // it 422 on the missing client, mirroring the NOT NULL DB constraint. Blocking here would
  // hide the override dialog for a staff member who hasn't picked a client yet.
  saving.value = true;

  let result;
  if (props.appointment) {
    result = await rescheduleAppointment(props.appointment.id, {
      professional_user_id: Number(form.professional_user_id) || undefined,
      service_id: Number(form.service_id) || undefined,
      resource_id: Number(form.resource_id) || undefined,
      date: form.date || undefined,
      start: form.start || undefined,
      duration_minutes: Number(form.duration_minutes) || undefined,
      override,
    });
  } else {
    result = await scheduleAppointment(buildBody(override));
  }
  saving.value = false;

  if (!result.ok) {
    toast.error(props.appointment ? 'rescheduleFailed' : 'scheduleFailed');
    fieldErrors.value = fieldErrorMessages(result);
    if (fieldErrors.value.start || fieldErrors.value.duration_minutes) sobreturno.value = true;
    return;
  }

  const payload = result.data;
  if (!payload.saved) {
    // Conflict detected — hand off to parent (which will open ConflictOverrideDialog).
    emit('conflictDetected', payload.verdict, save);
  } else {
    emit('saved', payload.appointment);
  }
}

function submit() {
  // A time is required either via slot pick or manual entry — surface the manual
  // section instead of letting a hidden required input silently block submission.
  if (!form.start || !form.duration_minutes) {
    sobreturno.value = true;
    fieldErrors.value = {
      ...(!form.start ? { start: t('calendar.selectTimeError') } : {}),
      ...(!form.duration_minutes ? { duration_minutes: t('generic.required') } : {}),
    };
    return;
  }
  void save(false);
}
</script>

<template>
  <form class="grid grid-cols-1 gap-4 sm:grid-cols-2" @submit.prevent="submit">
   <template v-if="!seriesResult">
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-client">{{ t('calendar.clientLabel') }} *</label>
      <Selector
        id="appt-client"
        searchable
        :readonly="clientLocked"
        :model-value="form.client_user_id || null"
        :options="clientOptions"
        :extra-search="(o) => o.dni"
        :placeholder="t('calendar.searchClient')"
        @update:model-value="form.client_user_id = $event ?? ''"
      >
        <template #option="{ option, selected }">
          <div class="flex items-baseline gap-2">
            <span class="flex-shrink-0" :class="selected ? 'font-semibold' : 'font-medium'">{{ option.label }}</span>
            <span v-if="option.dni" class="min-w-0 truncate text-xs text-neutral">DNI {{ option.dni }}</span>
          </div>
        </template>
      </Selector>
      <FieldError :message="fieldErrors.client_user_id" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-prof">{{ t('calendar.professionalLabel') }} *</label>
      <Selector
        id="appt-prof"
        searchable
        :model-value="form.professional_user_id || null"
        :options="availableProfessionalOptions"
        :placeholder="t('calendar.searchProfessional')"
        @update:model-value="form.professional_user_id = $event ?? ''"
      />
      <FieldError :message="fieldErrors.professional_user_id" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-service">{{ t('calendar.serviceLabel') }} *</label>
      <Selector
        id="appt-service"
        :model-value="form.service_id || null"
        :options="availableServiceOptions"
        :placeholder="t('calendar.selectServicePlaceholder')"
        @update:model-value="form.service_id = $event ?? ''"
      />
      <FieldError :message="fieldErrors.service_id" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-resource">{{ t('calendar.resourceLabel') }}</label>
      <select
        id="appt-resource"
        v-model="form.resource_id"
        class="rounded border border-border px-3 py-2 text-sm"
      >
        <option value="">{{ t('calendar.noRoom') }}</option>
        <option v-for="opt in resourceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <div class="flex flex-col gap-1 sm:col-span-2">
      <label class="text-sm font-semibold" for="appt-date">{{ t('calendar.dateLabel') }} *</label>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border text-neutral hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="atMinDate"
          :aria-label="t('calendar.prevDay')"
          @click="stepDate(-1)"
        >
          <ChevronLeftIcon class="h-5 w-5" />
        </button>
        <DateField
          id="appt-date"
          v-model="form.date"
          :invalid="!!fieldErrors.date"
          :min="props.appointment ? null : minDate"
          :max="props.appointment ? null : windowMax"
          class="flex-1"
        />
        <button
          type="button"
          class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border text-neutral hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="atMaxDate"
          :aria-label="t('calendar.nextDay')"
          @click="stepDate(1)"
        >
          <ChevronRightIcon class="h-5 w-5" />
        </button>
      </div>
      <FieldError :message="fieldErrors.date" />
    </div>

    <label class="inline-flex items-center gap-2 self-start text-sm font-medium cursor-pointer sm:col-span-2">
      <input v-model="sobreturno" type="checkbox" class="h-4 w-4 accent-accent" />
      {{ t('calendar.fineMode') }}
    </label>

    <SlotPicker
      v-if="!sobreturno"
      class="sm:col-span-2"
      :professional-id="form.professional_user_id ? Number(form.professional_user_id) : null"
      :service-id="form.service_id ? Number(form.service_id) : null"
      :date="form.date || null"
      :model-value="form.start || null"
      @update:model-value="(v) => { form.start = v ?? '' }"
      @slot-selected="handleSlotSelected"
    />

    <div v-if="sobreturno" class="flex gap-3 sm:col-span-2">
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="appt-start">{{ t('calendar.timeLabel') }} *</label>
        <TimeField id="appt-start" v-model="form.start" :invalid="!!fieldErrors.start" />
        <FieldError :message="fieldErrors.start" />
      </div>
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="appt-duration">{{ t('calendar.durationLabel') }} *</label>
        <input
          id="appt-duration"
          v-model="form.duration_minutes"
          type="number"
          min="1"
          class="rounded border border-border px-3 py-2 text-sm"
        />
        <FieldError :message="fieldErrors.duration_minutes" />
      </div>
    </div>

    <template v-if="!props.appointment">
      <label
        class="inline-flex items-center gap-2 self-start text-sm font-medium cursor-pointer sm:col-span-2"
      >
        <input id="appt-recurrence" v-model="recurrenceEnabled" type="checkbox" class="h-4 w-4 accent-accent" />
        {{ t('calendar.recurrenceToggle') }}
      </label>

      <RecurrenceRuleFields
        v-if="recurrenceEnabled"
        :recurrence="recurrence"
        :field-errors="fieldErrors"
        :min-end-date="form.date || null"
        @weekday-picked="weekdayTouched = true"
      />
    </template>

    <div class="flex flex-col gap-1 sm:col-span-2">
      <label class="text-sm font-semibold" for="appt-name">{{ label(appointmentColumns.name.label) }}</label>
      <input
        id="appt-name"
        v-model="form.name"
        type="text"
        class="rounded border border-border px-3 py-2 text-sm"
        maxlength="200"
      />
    </div>

    <div class="flex flex-col gap-1 sm:col-span-2">
      <label class="text-sm font-semibold" for="appt-desc">{{ label(appointmentColumns.description.label) }}</label>
      <textarea
        id="appt-desc"
        v-model="form.description"
        rows="2"
        class="rounded border border-border px-3 py-2 text-sm"
      />
    </div>

    <div class="flex gap-2 pt-2 sm:col-span-2">
      <AppButton type="submit" variant="primary" :loading="saving">
        {{ t('actions.save') }}
      </AppButton>
      <AppButton type="button" variant="neutral" @click="emit('cancel')">
        {{ t('actions.cancel') }}
      </AppButton>
    </div>
   </template>

   <div v-else data-testid="series-report" class="flex flex-col gap-3 sm:col-span-2">
     <h3 class="text-sm font-semibold">{{ t('calendar.seriesSkippedTitle') }}</h3>
     <p v-if="seriesResult.preview.skipped.length === 0" class="text-sm text-neutral">
       {{ t('calendar.seriesNoConflicts') }}
     </p>
     <p v-else class="text-sm text-neutral">{{ t('calendar.seriesConflictsNote') }}</p>
     <ul v-if="seriesResult.preview.skipped.length > 0" class="flex flex-col gap-2">
       <li v-for="skip in seriesResult.preview.skipped" :key="skip.date" class="text-sm">
         <span class="font-medium">{{ skip.date }}</span>
         <ul class="list-disc list-inside text-neutral">
           <li v-for="(line, i) in describeSkip(skip)" :key="i">{{ line }}</li>
         </ul>
       </li>
     </ul>
     <div class="flex gap-2 pt-2">
       <AppButton type="button" variant="primary" @click="emit('cancel')">
         {{ t('actions.close') }}
       </AppButton>
     </div>
   </div>
  </form>
</template>
