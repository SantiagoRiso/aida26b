<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { getRow, deleteRow } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { getBalance, getLedger } from '@/api/ledger';
import type { LedgerEntry } from '@/api/ledger';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { isOpenAppointmentState } from '@shared/ssot/domain';
import { useLedgerLabel } from '@/composables/useLedgerLabel';
import { useCurrency } from '@/composables/useCurrency';
import { useLabel } from '@/composables/useLabel';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor } from '@/router/access';
import type { Role, TableRecordMap } from '@shared/types/types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import GenericForm from '@/components/generic/GenericForm.vue';
import LedgerEntryForm from '@/components/ledger/LedgerEntryForm.vue';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';

const props = defineProps<{ clientId: number }>();
const emit = defineEmits<{
  close: [];
  // Something changed that the clients list should reflect (e.g. a deactivation).
  changed: [];
}>();

const { t } = useI18n();
const { formatARS, formatDateTime } = useCurrency();
const { label } = useLabel();
const toast = useToast();
const auth = useAuthStore();

const clientId = props.clientId;

const client = ref<TableRecordMap['clients'] | null>(null);
const balance = ref<string | null>(null);
const entries = ref<LedgerEntry[]>([]);
const appointments = ref<Appointment[]>([]);
const { labelFor: professionalLabelFor } = useForeignKeyOptions({ table: 'professionals', valueField: 'id', labelField: 'display_name' });
const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });
const loading = ref(true);

const showEntryForm = ref(false);
const showBookForm = ref(false);
const showEditProfile = ref(false);

const cancelId = ref<number | null>(null);
const cancelConfirmOpen = ref(false);
const deactivateConfirmOpen = ref(false);

const conflictOpen = ref(false);
const conflictVerdict = ref<ConflictVerdict | null>(null);
const conflictRetryFn = ref<((override: boolean) => Promise<void>) | null>(null);

const role = computed(() => auth.user?.role as Role | undefined);
const canCreateLedger = computed(() => !!role.value && roleAllowedFor(['Admin', 'Receptionist', 'Professional'], role.value));
const canEditProfile = computed(() => !!role.value && roleAllowedFor(['Admin', 'Receptionist'], role.value));
const canDeactivate = computed(() => !!role.value && roleAllowedFor(['Admin'], role.value));

// Ledger reads are server-scoped: an Admin sees any client in the business, but a Professional or
// Receptionist only clients they've actually seen. Gate the whole Cuenta Corriente section on that
// so we never fire (and toast on) a read we aren't allowed to make.
const ledgerAccessible = computed(() => role.value === 'Admin' || appointments.value.length > 0);

const balancePositive = computed(() => balance.value != null && parseFloat(balance.value) > 0);

// Pending = still actionable (requested or scheduled); these can be cancelled.
const pendingAppointments = computed(() =>
  appointments.value
    .filter((a) => isOpenAppointmentState(a.state))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
);

// Closed/past appointments only — the pending ones are already shown in the "Pendientes"
// list above, so the history table must not repeat them.
const historyAppointments = computed(() =>
  appointments.value
    .filter((a) => !isOpenAppointmentState(a.state))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
);

const { entryTypeLabel, entryBadgeClass } = useLedgerLabel();

const professionalName = (id: number) => professionalLabelFor(id) ?? `#${id}`;
const serviceName = (id: number) => serviceLabelFor(id) ?? `#${id}`;

async function loadProfile() {
  const res = await getRow('clients', clientId);
  if (res.ok) client.value = res.data;
}

async function loadLedger() {
  const [bal, led] = await Promise.all([getBalance(clientId), getLedger(clientId, 1, 50)]);
  balance.value = bal.ok ? bal.data.balance_ars : null;
  entries.value = led.ok ? led.data : [];
}

async function loadAppointments() {
  const res = await listAppointments({ client_user_id: clientId, limit: 500 });
  appointments.value = res.ok ? res.data : [];
}

async function load() {
  loading.value = true;
  // Appointments first: ledger access depends on whether the viewer has seen this client.
  await Promise.all([loadProfile(), loadAppointments()]);
  if (ledgerAccessible.value) await loadLedger();
  loading.value = false;
}

function onEntrySaved() {
  showEntryForm.value = false;
  loadLedger();
}

function onProfileSaved() {
  showEditProfile.value = false;
  loadProfile();
  emit('changed');
}

async function onBookSaved() {
  showBookForm.value = false;
  // A first booking makes this client "seen" — reload appointments, then the ledger if now readable.
  await loadAppointments();
  if (ledgerAccessible.value) await loadLedger();
  emit('changed');
}

function onFormConflict(verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>) {
  conflictVerdict.value = verdict;
  conflictRetryFn.value = retryFn;
  conflictOpen.value = true;
}

async function onOverrideConfirm() {
  conflictOpen.value = false;
  if (conflictRetryFn.value) await conflictRetryFn.value(true);
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
}

function onOverrideCancel() {
  conflictOpen.value = false;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
}

function requestCancel(id: number) {
  cancelId.value = id;
  cancelConfirmOpen.value = true;
}

async function confirmCancel() {
  cancelConfirmOpen.value = false;
  if (cancelId.value == null) return;
  const res = await transitionAppointment(cancelId.value, 'canceled');
  cancelId.value = null;
  if (res.ok) {
    toast.success('appointmentCanceled');
    loadAppointments();
  } else {
    toast.error('genericError');
  }
}

async function confirmDeactivate() {
  deactivateConfirmOpen.value = false;
  const res = await deleteRow('clients', clientId);
  if (res.ok) {
    emit('changed');
    emit('close');
  } else {
    toast.error('genericError');
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <div v-if="loading">
      <Skeleton variant="row" :rows="6" />
    </div>

    <template v-else-if="client">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold">{{ client.display_name }}</h1>
          <p class="text-sm text-neutral">
            <span v-if="client.dni">{{ label({ es: 'DNI', en: 'DNI' }) }} {{ client.dni }} · </span>{{ client.email ?? '—' }} · {{ client.phone ?? '—' }}
          </p>
          <p v-if="client.notes" class="mt-1 text-sm text-neutral italic">{{ client.notes }}</p>
        </div>
        <div class="flex gap-2">
          <AppButton v-if="canEditProfile" variant="neutral" @click="showEditProfile = true">
            {{ label({ es: 'Editar perfil', en: 'Edit profile' }) }}
          </AppButton>
          <AppButton v-if="canDeactivate" variant="destructive" @click="deactivateConfirmOpen = true">
            {{ label({ es: 'Desactivar', en: 'Deactivate' }) }}
          </AppButton>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
      <!-- Cuenta corriente — only for viewers allowed to read this client's ledger. -->
      <section v-if="ledgerAccessible" class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ label({ es: 'Cuenta corriente', en: 'Ledger' }) }}</h2>
          <AppButton v-if="canCreateLedger" variant="primary" @click="showEntryForm = true">
            {{ label({ es: 'Cargar pago / ajustar saldo', en: 'Load payment / adjust balance' }) }}
          </AppButton>
        </div>

        <div
          class="rounded-lg border p-4 flex items-center justify-between"
          :class="balancePositive ? 'border-destructive bg-red-50' : 'border-border bg-card'"
        >
          <span class="text-sm font-semibold text-heading">{{ label({ es: 'Saldo', en: 'Balance' }) }}</span>
          <span
            class="text-xl font-semibold tabular-nums"
            :class="balancePositive ? 'text-destructive' : 'text-success'"
          >
            {{ balance != null ? formatARS(balance) : '—' }}
          </span>
        </div>

        <div v-if="entries.length === 0">
          <EmptyState
            :heading="label({ es: 'Sin movimientos', en: 'No entries' })"
            :body="label({ es: 'No hay movimientos registrados para este cliente.', en: 'No ledger entries for this client.' })"
          />
        </div>
        <div v-else class="overflow-x-auto rounded-lg border border-border">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-surface">
              <tr>
                <th class="px-4 py-3 text-left font-semibold">{{ label({ es: 'Fecha', en: 'Date' }) }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ label({ es: 'Tipo', en: 'Type' }) }}</th>
                <th class="px-4 py-3 text-right font-semibold">{{ label({ es: 'Monto', en: 'Amount' }) }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ label({ es: 'Descripción', en: 'Description' }) }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border bg-card">
              <tr v-for="entry in entries" :key="entry.id">
                <td class="px-4 py-3 tabular-nums text-neutral">{{ formatDateTime(entry.created_at) }}</td>
                <td class="px-4 py-3">
                  <span
                    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                    :class="entryBadgeClass(entry.entry_type)"
                  >
                    {{ entryTypeLabel(entry.entry_type) }}
                  </span>
                </td>
                <td class="px-4 py-3 text-right tabular-nums font-semibold">{{ formatARS(entry.amount_ars) }}</td>
                <td class="px-4 py-3 text-neutral">{{ entry.description ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Turnos — upcoming/pending only; history lives full-width below. -->
      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ label({ es: 'Turnos pendientes', en: 'Pending appointments' }) }}</h2>
          <AppButton variant="primary" @click="showBookForm = true">
            {{ label({ es: 'Agendar turno', en: 'Book appointment' }) }}
          </AppButton>
        </div>

        <div v-if="pendingAppointments.length > 0">
          <ul class="divide-y divide-border rounded-lg border border-border bg-card">
            <li v-for="appt in pendingAppointments" :key="appt.id" class="flex items-center justify-between px-4 py-3">
              <div class="text-sm">
                <span class="font-medium tabular-nums">{{ formatDateTime(appt.starts_at) }}</span>
                <span class="text-neutral"> · {{ serviceName(appt.service_id) }} · {{ professionalName(appt.professional_user_id) }}</span>
                <span class="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs">{{ t(`status.${appt.state}`) }}</span>
              </div>
              <button
                type="button"
                class="rounded-md px-2 py-1 text-sm text-destructive hover:bg-red-50"
                :title="t('calendar.cancel')"
                @click="requestCancel(appt.id)"
              >
                ✕
              </button>
            </li>
          </ul>
        </div>

        <EmptyState
          v-if="appointments.length === 0"
          :heading="label({ es: 'Sin turnos', en: 'No appointments' })"
          :body="label({ es: 'Este cliente todavía no tiene turnos.', en: 'This client has no appointments yet.' })"
        />
        <p v-else-if="pendingAppointments.length === 0" class="text-sm text-neutral">
          {{ label({ es: 'Sin turnos pendientes.', en: 'No upcoming appointments.' }) }}
        </p>
      </section>
      </div>

      <!-- Historial — full width so the table fits without a horizontal scrollbar. -->
      <section v-if="historyAppointments.length > 0" class="space-y-2">
        <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Historial', en: 'History' }) }}</h3>
        <div class="overflow-x-auto rounded-lg border border-border">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-surface">
              <tr>
                <th class="px-4 py-3 text-left font-semibold">{{ label({ es: 'Fecha', en: 'Date' }) }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ t('calendar.serviceLabel') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ t('calendar.professionalLabel') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ label({ es: 'Estado', en: 'State' }) }}</th>
                <th class="px-4 py-3 text-right font-semibold">{{ t('calendar.priceLabel') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border bg-card">
              <tr v-for="appt in historyAppointments" :key="appt.id">
                <td class="px-4 py-3 tabular-nums text-neutral">{{ formatDateTime(appt.starts_at) }}</td>
                <td class="px-4 py-3">{{ serviceName(appt.service_id) }}</td>
                <td class="px-4 py-3">{{ professionalName(appt.professional_user_id) }}</td>
                <td class="px-4 py-3">{{ t(`status.${appt.state}`) }}</td>
                <td class="px-4 py-3 text-right tabular-nums">{{ formatARS(appt.price) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-else>
      <EmptyState
        :heading="label({ es: 'Cliente no encontrado', en: 'Client not found' })"
        :body="label({ es: 'No pudimos cargar este cliente.', en: 'We could not load this client.' })"
      />
    </template>

    <!-- Ledger entry -->
    <DetailPanel :open="showEntryForm" :title="label({ es: 'Nuevo movimiento', en: 'New entry' })" @close="showEntryForm = false">
      <LedgerEntryForm :client-user-id="clientId" @saved="onEntrySaved" @cancelled="showEntryForm = false" />
    </DetailPanel>

    <!-- Book appointment -->
    <DetailPanel :open="showBookForm" :title="label({ es: 'Agendar turno', en: 'Book appointment' })" @close="showBookForm = false">
      <AppointmentForm
        :prefill-client-id="clientId"
        @saved="onBookSaved"
        @conflict-detected="onFormConflict"
        @cancel="showBookForm = false"
      />
    </DetailPanel>

    <!-- Edit profile -->
    <DetailPanel :open="showEditProfile" :title="label({ es: 'Editar perfil', en: 'Edit profile' })" @close="showEditProfile = false">
      <GenericForm
        v-if="client"
        table-key="clients"
        mode="edit"
        :initial="client ?? undefined"
        @saved="onProfileSaved"
        @cancel="showEditProfile = false"
      />
    </DetailPanel>

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />

    <ConfirmDialog
      :open="cancelConfirmOpen"
      :title="label({ es: 'Cancelar turno', en: 'Cancel appointment' })"
      :body="label({ es: '¿Confirmás la cancelación de este turno?', en: 'Confirm cancellation of this appointment?' })"
      :confirm-label="label({ es: 'Cancelar turno', en: 'Cancel appointment' })"
      :destructive="true"
      @confirm="confirmCancel"
      @cancel="cancelConfirmOpen = false"
    />

    <ConfirmDialog
      :open="deactivateConfirmOpen"
      :title="label({ es: 'Desactivar cliente', en: 'Deactivate client' })"
      :body="label({ es: `Desactivar a ${client?.display_name ?? ''}: no va a poder iniciar sesión ni ser asignado a nuevos turnos. ¿Confirmás?`, en: `Deactivate ${client?.display_name ?? ''}: they won't be able to log in or be assigned to new appointments. Confirm?` })"
      :confirm-label="label({ es: 'Desactivar', en: 'Deactivate' })"
      :destructive="true"
      @confirm="confirmDeactivate"
      @cancel="deactivateConfirmOpen = false"
    />
  </div>
</template>
