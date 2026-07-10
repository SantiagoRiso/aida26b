<script setup lang="ts">
// Staff create/edit form. Conflict check happens ON SAVE only — no live preview.
// On requires_override the parent receives the verdict and handles the override dialog.

import { computed, reactive, ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { scheduleAppointment, rescheduleAppointment } from '@/api/appointments';
import type { Appointment, ScheduleBody } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { listRows } from '@/api/crud';
import { useAuthStore } from '@/stores/auth';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { useToast } from '@/composables/useToast';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import Selector from '@/components/shared/Selector.vue';
import SlotPicker from './SlotPicker.vue';
import type { TimeInterval } from '@shared/ssot/domain/scheduling';
import type { TableRecordMap } from '@shared/types/types';

const props = defineProps<{
  // Presence switches the form to edit/reschedule mode.
  appointment?: Appointment;
  prefillDate?: string;
  prefillStart?: string;
  prefillProfessionalId?: number;
  prefillResourceId?: number;
  // Booking for a specific client (e.g. from the client detail page) — locks the client field.
  prefillClientId?: number;
}>();

const emit = defineEmits<{
  (e: 'saved', appt: Appointment): void;
  (e: 'conflictDetected', verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18n();
const toast = useToast();
const auth = useAuthStore();

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
  duration_minutes: String(props.appointment?.duration_minutes ?? ''),
  name: props.appointment?.name ?? '',
  description: props.appointment?.description ?? '',
});

const fieldErrors = ref<Record<string, string>>({});
const saving = ref(false);

// Hora/duración are normally derived from the picked slot; manual entry is the
// sobreturno path (booking outside published availability) and stays collapsed.
// Open it upfront when values arrive without a slot pick (reschedule, drag-select prefill).
// Reschedule opens manual entry; a clicked cell auto-selects its slot (see SlotPicker), so a bare
// prefilled start no longer forces manual mode.
const manualOpen = ref(!!props.appointment);

// Options carry the DNI so staff can find a client by document number, not just name.
interface ClientOption { value: string; label: string; dni: string }
const clientRows = ref<TableRecordMap['clients'][]>([]);
const clientOptions = computed<ClientOption[]>(() =>
  clientRows.value.map((c) => ({ value: String(c.id), label: c.display_name, dni: c.dni ?? '' })),
);
onMounted(async () => {
  const res = await listRows('clients', { limit: 200 });
  if (res.ok) clientRows.value = res.data;
});

// Locked when booking from a specific client's page — the client isn't a choice here.
const clientLocked = computed(() => props.prefillClientId != null);
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

// A professional may only book on their own calendar (the backend enforces own-only for
// professionals). Receptionist grant scoping is server-side: the professionals list they
// fetch already contains only granted calendars.
const availableProfessionalOptions = computed(() => {
  if (auth.user?.role === 'Professional') {
    return professionalOptions.value.filter((o) => String(o.value) === String(auth.user!.id));
  }
  return professionalOptions.value;
});
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

// Which services each professional offers (professional_user_id → service_ids). No entry / no
// professional selected → fall back to all services.
const profServiceMap = ref<Map<string, string[]>>(new Map());
onMounted(async () => {
  const result = await listRows('professional_services', { limit: 500 });
  if (!result.ok) return;
  const map = new Map<string, string[]>();
  for (const row of result.data) {
    const key = String(row.professional_user_id);
    const list = map.get(key);
    if (list) list.push(String(row.service_id));
    else map.set(key, [String(row.service_id)]);
  }
  profServiceMap.value = map;
});

const availableServiceOptions = computed(() => {
  const offered = form.professional_user_id
    ? profServiceMap.value.get(String(form.professional_user_id))
    : undefined;
  if (!offered || offered.length === 0) return serviceOptions.value;
  const set = new Set(offered);
  return serviceOptions.value.filter((o) => set.has(String(o.value)));
});

// Keep the selected service consistent with the professional's offerings (auto-pick the only one).
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
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  form.duration_minutes = String((eh * 60 + em) - (sh * 60 + sm));
  // Reflect the pick in the normal time/duration inputs rather than a separate summary control.
  manualOpen.value = true;
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
      if (result.fields.start || result.fields.duration_minutes) manualOpen.value = true;
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
    manualOpen.value = true;
    fieldErrors.value = {
      ...(!form.start ? { start: 'Elegí un horario o cargalo manualmente' } : {}),
      ...(!form.duration_minutes ? { duration_minutes: 'Requerido' } : {}),
    };
    return;
  }
  void save(false);
}
</script>

<template>
  <form class="flex flex-col gap-4" @submit.prevent="submit">
    <div class="flex flex-col gap-1">
      <label class="text-sm font-semibold" for="appt-client">{{ t('calendar.clientLabel') }} *</label>
      <Selector
        id="appt-client"
        searchable
        :readonly="clientLocked"
        :model-value="form.client_user_id || null"
        :options="clientOptions"
        :extra-search="(o) => o.dni"
        placeholder="Buscar cliente…"
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
        placeholder="Buscar profesional…"
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
        placeholder="— Seleccionar servicio —"
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

    <button
      v-if="!manualOpen"
      type="button"
      class="self-start text-xs text-accent hover:underline"
      @click="manualOpen = true"
    >
      Cargar horario manualmente (sobreturno)
    </button>

    <div v-if="manualOpen" class="flex gap-3">
      <div class="flex flex-col gap-1 flex-1">
        <label class="text-sm font-semibold" for="appt-start">Hora *</label>
        <input
          id="appt-start"
          v-model="form.start"
          type="time"
          class="rounded border border-border px-3 py-2 text-sm"
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
