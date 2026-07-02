<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getBalance, getLedger } from '@/api/ledger';
import { listRows } from '@/api/crud';
import type { LedgerEntry } from '@/api/ledger';
import { LEDGER_ENTRY_TYPES } from '@shared/ssot/domain/finance';
import { useCurrency } from '@/composables/useCurrency';
import { useLabel } from '@/composables/useLabel';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { roleAllowedFor } from '@/router/access';
import type { Role } from '@shared/types/types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Pagination from '@/components/generic/Pagination.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import LedgerEntryForm from '@/components/ledger/LedgerEntryForm.vue';

const { t } = useI18n();
const auth = useAuthStore();
const ui = useUiStore();
const { formatARS, formatDateTime } = useCurrency();
const { label } = useLabel();

interface ClientRow { id: number; display_name: string }
const clients = ref<ClientRow[]>([]);
const loadingClients = ref(false);

const selectedClientId = ref<number | null>(null);
const balance = ref<string | null>(null);
const loadingBalance = ref(false);

const entries = ref<LedgerEntry[]>([]);
const loadingEntries = ref(false);
const page = ref(1);
const limit = 50;
const total = ref(0);

const showEntryForm = ref(false);

// Ledger create is allowed for Admin and Receptionist (SSOT roleRequired.create).
const canCreate = computed(() => {
  const role = auth.user?.role as Role | undefined;
  return !!role && roleAllowedFor(['Admin', 'Receptionist'], role);
});

// Positive balance = client owes money → destructive indicator.
const balancePositive = computed(() => {
  if (balance.value == null) return false;
  return parseFloat(balance.value) > 0;
});

const entryTypeLabel = (value: string) => {
  const found = LEDGER_ENTRY_TYPES.find((t) => t.value === value);
  return found ? label(found.label) : value;
};

async function loadClients() {
  loadingClients.value = true;
  const result = await listRows<ClientRow>('clients', { limit: 500 });
  if (result.ok) {
    clients.value = result.data;
  }
  loadingClients.value = false;
}

async function loadBalance(clientId: number) {
  loadingBalance.value = true;
  const result = await getBalance(clientId);
  if (result.ok) {
    balance.value = result.data.balance_ars;
  } else {
    balance.value = null;
  }
  loadingBalance.value = false;
}

async function loadEntries(clientId: number) {
  loadingEntries.value = true;
  const result = await getLedger(clientId, page.value, limit);
  if (result.ok) {
    entries.value = result.data;
    if (result.meta) total.value = result.meta.total;
  }
  loadingEntries.value = false;
}

watch(selectedClientId, (id) => {
  if (id == null) {
    balance.value = null;
    entries.value = [];
    total.value = 0;
    return;
  }
  page.value = 1;
  loadBalance(id);
  loadEntries(id);
});

watch(page, (newPage) => {
  if (selectedClientId.value != null) {
    loadEntries(selectedClientId.value);
  }
});

function onEntrySaved() {
  showEntryForm.value = false;
  if (selectedClientId.value != null) {
    loadBalance(selectedClientId.value);
    loadEntries(selectedClientId.value);
  }
}

loadClients();
</script>

<template>
  <div class="p-6">
    <h1 class="text-[28px] font-semibold leading-tight text-heading mb-6">
      {{ label({ es: 'Cuenta Corriente', en: 'Ledger' }) }}
    </h1>

    <div class="mb-6 max-w-sm">
      <label class="block text-sm font-semibold text-heading mb-1">
        {{ label({ es: 'Cliente', en: 'Client' }) }}
      </label>
      <select
        v-model="selectedClientId"
        class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <option :value="null">{{ label({ es: 'Seleccioná un cliente', en: 'Select a client' }) }}</option>
        <option
          v-for="client in clients"
          :key="client.id"
          :value="client.id"
        >
          {{ client.display_name }}
        </option>
      </select>
    </div>

    <template v-if="selectedClientId != null">
      <div
        class="mb-6 rounded-lg border p-4 flex items-center justify-between"
        :class="balancePositive
          ? 'border-destructive bg-red-50'
          : 'border-border bg-card'"
      >
        <span class="text-sm font-semibold text-heading">
          {{ label({ es: 'Saldo', en: 'Balance' }) }}
        </span>
        <template v-if="loadingBalance">
          <span class="text-sm text-neutral">{{ t('loading') }}</span>
        </template>
        <template v-else>
          <span
            class="text-xl font-semibold tabular-nums"
            :class="balancePositive ? 'text-destructive' : 'text-success'"
          >
            {{ balance != null ? formatARS(balance) : '—' }}
          </span>
        </template>
      </div>

      <div class="mb-4 flex justify-end">
        <AppButton
          v-if="canCreate"
          variant="primary"
          @click="showEntryForm = true"
        >
          {{ label({ es: 'Nuevo movimiento', en: 'New entry' }) }}
        </AppButton>
      </div>

      <div v-if="loadingEntries">
        <Skeleton variant="row" :rows="5" />
      </div>

      <div v-else-if="entries.length === 0">
        <EmptyState
          :heading="label({ es: 'Sin movimientos', en: 'No entries' })"
          :body="label({ es: 'No hay movimientos registrados para este cliente.', en: 'No ledger entries for this client.' })"
        />
      </div>

      <div v-else class="overflow-x-auto rounded-lg border border-border">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-surface">
            <tr>
              <th class="px-4 py-3 text-left font-semibold text-heading">
                {{ label({ es: 'Fecha', en: 'Date' }) }}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-heading">
                {{ label({ es: 'Tipo', en: 'Type' }) }}
              </th>
              <th class="px-4 py-3 text-right font-semibold text-heading">
                {{ label({ es: 'Monto', en: 'Amount' }) }}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-heading">
                {{ label({ es: 'Descripción', en: 'Description' }) }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border bg-card">
            <tr v-for="entry in entries" :key="entry.id" class="hover:bg-surface">
              <td class="px-4 py-3 tabular-nums text-neutral">
                {{ formatDateTime(entry.created_at) }}
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                  :class="{
                    'bg-red-100 text-destructive':  entry.entry_type === 'charge' || entry.entry_type === 'adjustment_debit',
                    'bg-green-100 text-success':    entry.entry_type === 'payment' || entry.entry_type === 'adjustment_credit',
                  }"
                >
                  {{ entryTypeLabel(entry.entry_type) }}
                </span>
              </td>
              <td class="px-4 py-3 text-right tabular-nums font-semibold">
                {{ formatARS(entry.amount_ars) }}
              </td>
              <td class="px-4 py-3 text-neutral">
                {{ entry.description ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Pagination
        v-if="total > limit"
        :page="page"
        :limit="limit"
        :total="total"
        class="mt-4"
        @change="page = $event"
      />
    </template>

    <template v-else>
      <EmptyState
        :heading="label({ es: 'Seleccioná un cliente', en: 'Select a client' })"
        :body="label({ es: 'Elegí un cliente para ver su cuenta corriente.', en: 'Choose a client to view their ledger.' })"
      />
    </template>

    <DetailPanel :open="showEntryForm" :title="label({ es: 'Nuevo movimiento', en: 'New entry' })" @close="showEntryForm = false">
      <LedgerEntryForm
        v-if="selectedClientId != null"
        :client-user-id="selectedClientId"
        @saved="onEntrySaved"
        @cancelled="showEntryForm = false"
      />
    </DetailPanel>
  </div>
</template>
