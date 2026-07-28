<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { LEDGER_ENTRY_TYPES } from '@shared/ssot/domain/finance';
import { AMOUNT_PATTERN } from '@shared/ssot/domain/catalog';
import { createEntry } from '@/api/ledger';
import { fieldErrorMessages, apiErrorMessage } from '@/i18n/api-errors';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { structure } from '@shared/ssot/structure';
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
const { label } = useLabel();
const ledgerColumns = structure.tables.ledger_entries.columns;

const entryType = ref('');
const amountArs = ref('');
const appointmentId = ref<string | null>(null);
const description = ref('');
const loading = ref(false);
const fieldErrors = ref<Record<string, string>>({});

const appointments = ref<Appointment[]>([]);
const loadingAppointments = ref(false);

// Every staff role may post any entry type. What differs is scope, which the server owns: a
// professional is limited to their own clients, and a receptionist to the calendars they hold a
// grant for.
const role = computed(() => auth.user?.role);
const isReceptionist = computed(() => role.value === 'Receptionist');

const availableTypes = computed(() => LEDGER_ENTRY_TYPES);

// Everyone links a charge to its appointment; a receptionist must also link the payment they take.
// For Admin and Professional a payment stays unallocated, which is what makes partial and multiple
// payments work. An adjustment never offers the picker: it corrects a balance rather than settling
// a session, so there is no turno to name.
const showAppointmentPicker = computed(
  () => entryType.value === 'charge' || (isReceptionist.value && entryType.value === 'payment'),
);

// Enforced server-side too.
const appointmentRequired = computed(() => isReceptionist.value && showAppointmentPicker.value);

// Only a charge defaults to the appointment's booked price. A payment may be partial, so leaving it
// blank is the honest default.
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
    const result = await listAppointments({ client_user_id: props.clientUserId, limit: 200 });
    if (result.ok) {
      // A charge must link to a real appointment row — a virtual (un-materialized) occurrence has
      // none yet, so it's not a selectable option here.
      appointments.value = result.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
    }
    loadingAppointments.value = false;
  }
});

watch(entryType, () => {
  if (!showAppointmentPicker.value) {
    appointmentId.value = null;
  }
});

async function submit() {
  fieldErrors.value = {};

  if (!entryType.value) {
    fieldErrors.value.entry_type = t('ledger.typeRequired');
    return;
  }
  // The amount may be omitted only for a charge, which the server fills from the appointment's
  // booked price. A payment always carries its own amount because it may be partial.
  const inheritsAppointmentPrice = entryType.value === 'charge' && appointmentId.value != null;
  if (!amountArs.value && !inheritsAppointmentPrice) {
    fieldErrors.value.amount_ars = t('ledger.amountRequired');
    return;
  }
  if (appointmentRequired.value && !appointmentId.value) {
    fieldErrors.value.appointment_id = t('ledger.appointmentRequired');
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
    const serverFieldErrors = fieldErrorMessages(result);
    if (Object.keys(serverFieldErrors).length > 0) {
      fieldErrors.value = serverFieldErrors;
    } else {
      // A rejection that names no field still has a reason worth reading: the turno is already
      // charged, the calendar is not granted, the client belongs to another business. Reporting
      // all of those as "ocurrió un error" hid the one thing the writer could act on.
      fieldErrors.value = { _: apiErrorMessage(result) };
    }
    return;
  }

  emit('saved');
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <FieldError :message="fieldErrors._" />

    <div>
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ t('portal.type') }} <span class="text-destructive">*</span>
      </label>
      <select
        v-model="entryType"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        required
      >
        <option value="">{{ t('ledger.selectType') }}</option>
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
        {{ label(ledgerColumns.appointment_id.label) }}
        <span v-if="appointmentRequired" class="text-destructive"> *</span>
      </label>
      <select
        v-model="appointmentId"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :required="appointmentRequired"
      >
        <option :value="null">{{ t('ledger.noAppointment') }}</option>
        <option
          v-for="appt in appointments"
          :key="appt.id"
          :value="appt.id"
        >
          {{ appt.name || appt.starts_at.slice(0, 10) }}{{ appt.price != null ? ' · $' + appt.price : '' }}
        </option>
      </select>
      <FieldError :message="fieldErrors.appointment_id" />
    </div>

    <div>
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label(ledgerColumns.amount_ars.label) }}
      </label>
      <input
        v-model="amountArs"
        type="text"
        inputmode="decimal"
        :pattern="AMOUNT_PATTERN"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent font-variant-numeric tabular-nums"
        :placeholder="t('ledger.amountPlaceholder')"
      />
      <FieldError :message="fieldErrors.amount_ars" />
    </div>

    <div>
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label(ledgerColumns.description.label) }}
      </label>
      <textarea
        v-model="description"
        rows="2"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
      />
      <FieldError :message="fieldErrors.description" />
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
