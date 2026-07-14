<script setup lang="ts">
// Conflict check happens ON SAVE only — no live preview.
// On requires_override the parent receives the verdict and handles the override dialog.

import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { scheduleAppointment, rescheduleAppointment } from '@/api/appointments';
import type { Appointment, ScheduleBody } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { useBookingOptions } from '@/composables/useBookingOptions';
import { useToast } from '@/composables/useToast';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import Selector from '@/components/shared/Selector.vue';
import SlotPicker from './SlotPicker.vue';
import DateField from '@/components/shared/DateField.vue';
import TimeField from '@/components/shared/TimeField.vue';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/20/solid';
import { isoDate, addDaysISO, intervalMinutes } from '@/composables/bookingForm';
import { useBookingWindow } from '@/composables/useBookingWindow';
import type { TimeInterval } from '@shared/ssot/domain/availability';
import { structure } from '@shared/ssot/structure';
import { useLabel } from '@/composables/useLabel';

const props = defineProps<{
  // Presence switches the form to edit/reschedule mode.
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

// starts_at is stored UTC; the date/time inputs (and the backend) work in local wall-clock time,
// so derive them from a Date rather than slicing the ISO string (which would leak the UTC offset).
function localDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
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

async function save(override = false): Promise<void> {
  fieldErrors.value = {};

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
    if (result.fields) {
      fieldErrors.value = result.fields;
      if (result.fields.start || result.fields.duration_minutes) sobreturno.value = true;
    }
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
  </form>
</template>
