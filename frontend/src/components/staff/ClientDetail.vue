<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { useClientProfile } from '@/composables/useClientProfile';
import { useClientAppointments } from '@/composables/useClientAppointments';
import { useClientLedger } from '@/composables/useClientLedger';
import { useClientAccount } from '@/composables/useClientAccount';
import { useLedgerLabel } from '@/composables/useLedgerLabel';
import { useCurrency } from '@/composables/useCurrency';
import { useStateLabel } from '@/composables/useStateLabel';
import { useConflictOverride } from '@/composables/useConflictOverride';
import { useLabel } from '@/composables/useLabel';
import { structure } from '@shared/ssot/structure';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import FieldError from '@/components/shared/FieldError.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';
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
const { stateLabel } = useStateLabel();
const { entryTypeLabel, entryBadgeClass } = useLedgerLabel();
const { label } = useLabel();
const clientColumns = structure.tables.clients.columns;
const ledgerColumns = structure.tables.ledger_entries.columns;
const appointmentColumns = structure.tables.appointments.columns;

const clientId = props.clientId;

const { client, loadProfile, showEditProfile, canEditProfile, onProfileSaved } =
  useClientProfile(clientId, () => emit('changed'));

const {
  appointments, loadAppointments, pendingAppointments, historyAppointments,
  cancelConfirmOpen, requestCancel, confirmCancel,
} = useClientAppointments(clientId);

const {
  balance, entries, loadLedger, ledgerAccessible, balancePositive,
  canCreateLedger, showEntryForm, onEntrySaved,
} = useClientLedger(clientId, appointments);

const {
  canDeactivate, canEnableLogin, deactivateConfirmOpen, confirmDeactivate,
  showEnableLogin, enableLoginSubmitting, enableLoginError, enableLoginForm, submitEnableLogin,
} = useClientAccount(clientId, {
  client,
  reloadProfile: loadProfile,
  onChanged: () => emit('changed'),
  onClose: () => emit('close'),
});

const { labelFor: professionalLabelFor } = useForeignKeyOptions({ table: 'professionals', valueField: 'id', labelField: 'display_name' });
const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });
const professionalName = (id: number | string) => professionalLabelFor(id) ?? `#${id}`;
const serviceName = (id: number | string) => serviceLabelFor(id) ?? `#${id}`;

const loading = ref(true);
const showBookForm = ref(false);

const { conflictOpen, conflictVerdict, raiseConflict, onOverrideConfirm, onOverrideCancel } =
  useConflictOverride();

async function load() {
  loading.value = true;
  // Appointments first: ledger access depends on whether the viewer has seen this client.
  await Promise.all([loadProfile(), loadAppointments()]);
  if (ledgerAccessible.value) await loadLedger();
  loading.value = false;
}

async function onBookSaved() {
  showBookForm.value = false;
  // A first booking makes this client "seen" — reload appointments, then the ledger if now readable.
  await loadAppointments();
  if (ledgerAccessible.value) await loadLedger();
  emit('changed');
}

function onFormConflict(verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>) {
  raiseConflict(verdict, retryFn);
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
            <span v-if="client.dni">{{ label(clientColumns.dni.label) }} {{ client.dni }} · </span>{{ client.email ?? '—' }} · {{ client.phone ?? '—' }}
          </p>
          <p v-if="client.notes" class="mt-1 text-sm text-neutral italic">{{ client.notes }}</p>
        </div>
        <div class="flex gap-2">
          <AppButton v-if="canEnableLogin" variant="neutral" @click="showEnableLogin = true">
            {{ t('clients.createUser') }}
          </AppButton>
          <AppButton v-if="canEditProfile" variant="neutral" @click="showEditProfile = true">
            {{ t('users.editProfile') }}
          </AppButton>
          <AppButton v-if="canDeactivate" variant="destructive" @click="deactivateConfirmOpen = true">
            {{ t('users.deactivate') }}
          </AppButton>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
      <section v-if="ledgerAccessible" class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ t('clients.ledgerHeading') }}</h2>
          <AppButton v-if="canCreateLedger" variant="primary" @click="showEntryForm = true">
            {{ t('clients.loadPayment') }}
          </AppButton>
        </div>

        <div
          class="rounded-lg border p-4 flex items-center justify-between"
          :class="balancePositive ? 'border-destructive bg-red-50' : 'border-border bg-card'"
        >
          <span class="text-sm font-semibold text-heading">{{ t('clients.balance') }}</span>
          <span
            class="text-xl font-semibold tabular-nums"
            :class="balancePositive ? 'text-destructive' : 'text-success'"
          >
            {{ balance != null ? formatARS(balance) : '—' }}
          </span>
        </div>

        <div v-if="entries.length === 0">
          <EmptyState
            :heading="t('clients.noEntriesHeading')"
            :body="t('clients.noEntriesBody')"
          />
        </div>
        <div v-else class="overflow-x-auto rounded-lg border border-border">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-surface">
              <tr>
                <th class="px-4 py-3 text-left font-semibold">{{ t('calendar.dateLabel') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ t('portal.type') }}</th>
                <th class="px-4 py-3 text-right font-semibold">{{ t('fields.amount') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ label(ledgerColumns.description.label) }}</th>
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

      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold">{{ t('clients.pendingAppointments') }}</h2>
          <AppButton variant="primary" @click="showBookForm = true">
            {{ t('clients.bookAppointment') }}
          </AppButton>
        </div>

        <div v-if="pendingAppointments.length > 0">
          <ul class="divide-y divide-border rounded-lg border border-border bg-card">
            <li v-for="appt in pendingAppointments" :key="appt.id" class="flex items-center justify-between px-4 py-3">
              <div class="text-sm">
                <span class="font-medium tabular-nums">{{ formatDateTime(appt.starts_at) }}</span>
                <span class="text-neutral"> · {{ serviceName(appt.service_id) }} · {{ professionalName(appt.professional_user_id) }}</span>
                <span class="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs">{{ stateLabel(appt.state) }}</span>
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
          :heading="t('clients.noAppointmentsHeading')"
          :body="t('clients.noAppointmentsBody')"
        />
        <p v-else-if="pendingAppointments.length === 0" class="text-sm text-neutral">
          {{ t('clients.noPending') }}
        </p>
      </section>
      </div>

      <!-- Historial — full width so the table fits without a horizontal scrollbar. -->
      <section v-if="historyAppointments.length > 0" class="space-y-2">
        <h3 class="text-sm font-semibold text-neutral">{{ t('portal.history') }}</h3>
        <div class="overflow-x-auto rounded-lg border border-border">
          <table class="min-w-full divide-y divide-border text-sm">
            <thead class="bg-surface">
              <tr>
                <th class="px-4 py-3 text-left font-semibold">{{ t('calendar.dateLabel') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ t('calendar.serviceLabel') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ t('calendar.professionalLabel') }}</th>
                <th class="px-4 py-3 text-left font-semibold">{{ label(appointmentColumns.state.label) }}</th>
                <th class="px-4 py-3 text-right font-semibold">{{ t('calendar.priceLabel') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border bg-card">
              <tr v-for="appt in historyAppointments" :key="appt.id">
                <td class="px-4 py-3 tabular-nums text-neutral">{{ formatDateTime(appt.starts_at) }}</td>
                <td class="px-4 py-3">{{ serviceName(appt.service_id) }}</td>
                <td class="px-4 py-3">{{ professionalName(appt.professional_user_id) }}</td>
                <td class="px-4 py-3">{{ stateLabel(appt.state) }}</td>
                <td class="px-4 py-3 text-right tabular-nums">{{ formatARS(appt.price) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <template v-else>
      <EmptyState
        :heading="t('clients.notFoundHeading')"
        :body="t('clients.notFoundBody')"
      />
    </template>

    <DetailPanel :open="showEntryForm" :title="t('clients.newEntry')" @close="showEntryForm = false">
      <LedgerEntryForm :client-user-id="clientId" @saved="onEntrySaved" @cancelled="showEntryForm = false" />
    </DetailPanel>

    <DetailPanel :open="showBookForm" size="3xl" :title="t('clients.bookAppointment')" @close="showBookForm = false">
      <AppointmentForm
        :prefill-client-id="clientId"
        @saved="onBookSaved"
        @conflict-detected="onFormConflict"
        @cancel="showBookForm = false"
      />
    </DetailPanel>

    <DetailPanel :open="showEditProfile" :title="t('users.editProfile')" @close="showEditProfile = false">
      <GenericForm
        v-if="client"
        table-key="clients"
        mode="edit"
        :initial="client ?? undefined"
        @saved="onProfileSaved"
        @cancel="showEditProfile = false"
      />
    </DetailPanel>

    <DetailPanel :open="showEnableLogin" :title="t('clients.createUser')" @close="showEnableLogin = false">
      <form class="space-y-4" @submit.prevent="submitEnableLogin" novalidate>
        <FieldError :message="enableLoginError" />

        <div class="flex flex-col gap-1">
          <label for="enable-login-username" class="text-sm font-semibold">
            {{ t('auth.usernameLabel') }} <span class="text-destructive">*</span>
          </label>
          <input
            id="enable-login-username"
            v-model="enableLoginForm.username"
            type="text"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="enable-login-password" class="text-sm font-semibold">
            {{ t('auth.passwordLabel') }} <span class="text-destructive">*</span>
          </label>
          <PasswordInput
            id="enable-login-password"
            v-model="enableLoginForm.password"
            input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <AppButton variant="neutral" type="button" @click="showEnableLogin = false">
            {{ t('actions.cancel') }}
          </AppButton>
          <AppButton type="submit" :loading="enableLoginSubmitting">
            {{ t('actions.save') }}
          </AppButton>
        </div>
      </form>
    </DetailPanel>

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />

    <ConfirmDialog
      :open="cancelConfirmOpen"
      :title="t('calendar.cancel')"
      :body="t('clients.cancelBody')"
      :confirm-label="t('calendar.cancel')"
      :destructive="true"
      @confirm="confirmCancel"
      @cancel="cancelConfirmOpen = false"
    />

    <ConfirmDialog
      :open="deactivateConfirmOpen"
      :title="t('clients.deactivateTitle')"
      :body="t('users.deactivateBody', { name: client?.display_name ?? '' })"
      :confirm-label="t('users.deactivate')"
      :destructive="true"
      @confirm="confirmDeactivate"
      @cancel="deactivateConfirmOpen = false"
    />
  </div>
</template>
