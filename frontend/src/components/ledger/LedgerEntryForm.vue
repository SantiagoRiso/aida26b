<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { LEDGER_ENTRY_TYPES } from '@shared/ssot/domain/finance';
import { createEntry } from '@/api/ledger';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useLabel } from '@/composables/useLabel';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';

const props = defineProps<{
  clientUserId: number;
}>();

const emit = defineEmits<{
  saved: [];
  cancelled: [];
}>();

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { label } = useLabel();

const entryType = ref('');
const amountArs = ref('');
const appointmentId = ref<number | null>(null);
const description = ref('');
const loading = ref(false);
const fieldErrors = ref<Record<string, string>>({});

const appointments = ref<Appointment[]>([]);
const loadingAppointments = ref(false);

// Only receptionists are restricted (appointment-linked charges). Admin and Professional — who
// ranks above a receptionist — may post any entry type; the server scopes professionals to their
// own clients.
const role = computed(() => auth.user?.role);
const isReceptionist = computed(() => role.value === 'Receptionist');

const availableTypes = computed(() => {
  if (isReceptionist.value) {
    return LEDGER_ENTRY_TYPES.filter((t) => t.value === 'charge');
  }
  return LEDGER_ENTRY_TYPES;
});

const showAppointmentPicker = computed(() => entryType.value === 'charge');

// A receptionist's charge must be linked to an appointment (enforced server-side too).
const appointmentRequired = computed(() => isReceptionist.value && entryType.value === 'charge');

watch(appointmentId, (id) => {
  if (id && entryType.value === 'charge') {
    const appt = appointments.value.find((a) => a.id === id);
    if (appt) {
      amountArs.value = appt.price ?? '';
    }
  }
});

watch(showAppointmentPicker, async (show) => {
  if (show && appointments.value.length === 0) {
    loadingAppointments.value = true;
    const result = await listAppointments({ limit: 200 });
    if (result.ok) {
      // Only this client's appointments may be charged here.
      appointments.value = result.data.filter((a) => a.client_user_id === props.clientUserId);
    }
    loadingAppointments.value = false;
  }
});

watch(entryType, (newType) => {
  if (newType !== 'charge') {
    appointmentId.value = null;
  }
});

async function submit() {
  fieldErrors.value = {};

  if (!entryType.value) {
    fieldErrors.value.entry_type = label({ es: 'Tipo requerido', en: 'Type required' });
    return;
  }
  if (!amountArs.value && !(showAppointmentPicker.value && appointmentId.value)) {
    fieldErrors.value.amount_ars = label({ es: 'Monto requerido', en: 'Amount required' });
    return;
  }
  if (appointmentRequired.value && !appointmentId.value) {
    fieldErrors.value.appointment_id = label({ es: 'Turno requerido para recepcionistas', en: 'Appointment required for receptionists' });
    return;
  }

  loading.value = true;
  const body: Parameters<typeof createEntry>[0] = {
    client_user_id: props.clientUserId,
    entry_type: entryType.value,
  };
  if (amountArs.value) body.amount_ars = amountArs.value;
  if (appointmentId.value) body.appointment_id = appointmentId.value;
  if (description.value) body.description = description.value;

  const result = await createEntry(body);
  loading.value = false;

  if (!result.ok) {
    if (result.fields) {
      fieldErrors.value = result.fields;
    } else {
      ui.toast('error', 'genericError');
    }
    return;
  }

  emit('saved');
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <div>
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label({ es: 'Tipo', en: 'Type' }) }}
      </label>
      <select
        v-model="entryType"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        required
      >
        <option value="">{{ label({ es: 'Seleccioná un tipo', en: 'Select a type' }) }}</option>
        <option
          v-for="type in availableTypes"
          :key="type.value"
          :value="type.value"
        >
          {{ label(type.label) }}
        </option>
      </select>
      <FieldError :message="fieldErrors.entry_type" />
    </div>

    <div v-if="showAppointmentPicker">
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label({ es: 'Turno', en: 'Appointment' }) }}
        <span v-if="appointmentRequired" class="text-destructive"> *</span>
      </label>
      <select
        v-model="appointmentId"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :required="appointmentRequired"
      >
        <option :value="null">{{ label({ es: 'Sin turno', en: 'No appointment' }) }}</option>
        <option
          v-for="appt in appointments"
          :key="appt.id"
          :value="appt.id"
        >
          {{ appt.name || appt.starts_at.slice(0, 10) }} — ${{ appt.price }}
        </option>
      </select>
      <FieldError :message="fieldErrors.appointment_id" />
    </div>

    <div>
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label({ es: 'Monto (ARS)', en: 'Amount (ARS)' }) }}
      </label>
      <input
        v-model="amountArs"
        type="text"
        inputmode="decimal"
        pattern="^\d+(\.\d{1,2})?$"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent font-variant-numeric tabular-nums"
        :placeholder="label({ es: 'Ej: 1500.00', en: 'E.g. 1500.00' })"
      />
      <FieldError :message="fieldErrors.amount_ars" />
    </div>

    <div>
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label({ es: 'Descripción', en: 'Description' }) }}
      </label>
      <textarea
        v-model="description"
        rows="2"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
      />
    </div>

    <div class="flex gap-3 justify-end pt-2">
      <AppButton variant="neutral" type="button" @click="emit('cancelled')">
        {{ t('actions.cancel') }}
      </AppButton>
      <AppButton variant="primary" type="submit" :loading="loading">
        {{ t('actions.save') }}
      </AppButton>
    </div>
  </form>
</template>
