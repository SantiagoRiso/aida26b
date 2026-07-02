<script setup lang="ts">
// Staff create/edit form. Conflict check happens ON SAVE only — no live preview.
// On requires_override the parent receives the verdict and handles the override dialog.

import { reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { scheduleAppointment, rescheduleAppointment } from '@/api/appointments';
import type { Appointment, ScheduleBody } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import SlotPicker from './SlotPicker.vue';
import type { TimeInterval } from '@shared/ssot/domain/scheduling';

const props = defineProps<{
  // Presence switches the form to edit/reschedule mode.
  appointment?: Appointment;
  prefillDate?: string;
  prefillStart?: string;
  prefillProfessionalId?: number;
}>();

const emit = defineEmits<{
  (e: 'saved', appt: Appointment): void;
  (e: 'conflictDetected', verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18n();

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

const form = reactive<FormState>({
  client_user_id: String(props.appointment?.client_user_id ?? ''),
  professional_user_id: String(props.prefillProfessionalId ?? props.appointment?.professional_user_id ?? ''),
  service_id: String(props.appointment?.service_id ?? ''),
  resource_id: String(props.appointment?.resource_id ?? ''),
  date: props.prefillDate ?? (props.appointment ? props.appointment.starts_at.slice(0, 10) : ''),
  start: props.prefillStart ?? '',
  duration_minutes: String(props.appointment?.duration_minutes ?? ''),
  name: props.appointment?.name ?? '',
  description: props.appointment?.description ?? '',
});

const fieldErrors = ref<Record<string, string>>({});
const saving = ref(false);

const { options: clientOptions } = useForeignKeyOptions({
  table: 'clients',
  valueField: 'id',
  labelField: 'display_name',
});
const { options: professionalOptions } = useForeignKeyOptions({
  table: 'professionals',
  valueField: 'id',
  labelField: 'display_name',
});
const { options: serviceOptions } = useForeignKeyOptions({
  table: 'services',
  valueField: 'id',
  labelField: 'name',
});
const { options: resourceOptions } = useForeignKeyOptions({
  table: 'resources',
  valueField: 'id',
  labelField: 'name',
});

// No client-side duration prefill on service change: server-side resolveBooking is authoritative.
watch(() => form.service_id, () => {});

function handleSlotSelected(slot: TimeInterval) {
  form.start = slot.start;
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  form.duration_minutes = String((eh * 60 + em) - (sh * 60 + sm));
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
    if (result.fields) fieldErrors.value = result.fields;
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
  void save(false);
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="submit">
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-client">{{ t('calendar.clientLabel') }} *</label>
      <select
        id="appt-client"
        v-model="form.client_user_id"
        class="rounded border border-border px-3 py-2 text-sm"
      >
        <option value="">— Seleccionar cliente —</option>
        <option v-for="opt in clientOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <FieldError :message="fieldErrors.client_user_id" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-prof">{{ t('calendar.professionalLabel') }} *</label>
      <select
        id="appt-prof"
        v-model="form.professional_user_id"
        class="rounded border border-border px-3 py-2 text-sm"
        required
      >
        <option value="">— Seleccionar profesional —</option>
        <option v-for="opt in professionalOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <FieldError :message="fieldErrors.professional_user_id" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-service">{{ t('calendar.serviceLabel') }} *</label>
      <select
        id="appt-service"
        v-model="form.service_id"
        class="rounded border border-border px-3 py-2 text-sm"
        required
      >
        <option value="">— Seleccionar servicio —</option>
        <option v-for="opt in serviceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <FieldError :message="fieldErrors.service_id" />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-resource">{{ t('calendar.resourceLabel') }}</label>
      <select
        id="appt-resource"
        v-model="form.resource_id"
        class="rounded border border-border px-3 py-2 text-sm"
      >
        <option value="">— Sin sala —</option>
        <option v-for="opt in resourceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-date">{{ t('calendar.dateLabel') }} *</label>
      <input
        id="appt-date"
        v-model="form.date"
        type="date"
        class="rounded border border-border px-3 py-2 text-sm"
        required
      />
      <FieldError :message="fieldErrors.date" />
    </div>

    <SlotPicker
      :professional-id="form.professional_user_id ? Number(form.professional_user_id) : null"
      :date="form.date || null"
      :model-value="form.start || null"
      @update:model-value="(v) => { form.start = v ?? '' }"
      @slot-selected="handleSlotSelected"
    />

    <div class="flex gap-3">
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="appt-start">Hora *</label>
        <input
          id="appt-start"
          v-model="form.start"
          type="time"
          class="rounded border border-border px-3 py-2 text-sm"
          required
        />
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
          required
        />
        <FieldError :message="fieldErrors.duration_minutes" />
      </div>
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-name">Título</label>
      <input
        id="appt-name"
        v-model="form.name"
        type="text"
        class="rounded border border-border px-3 py-2 text-sm"
        maxlength="200"
      />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-desc">Descripción</label>
      <textarea
        id="appt-desc"
        v-model="form.description"
        rows="2"
        class="rounded border border-border px-3 py-2 text-sm"
      />
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
