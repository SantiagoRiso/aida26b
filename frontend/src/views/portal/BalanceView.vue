<script setup lang="ts">
// Read-only: the client never modifies the ledger; server scopes results to the caller.

import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { getBalance, getLedger } from '@/api/ledger';
import type { LedgerEntry } from '@/api/ledger';
import { useCurrency } from '@/composables/useCurrency';
import { useLedgerLabel } from '@/composables/useLedgerLabel';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';

const { t } = useI18n();
const auth = useAuthStore();
const { formatARS, formatDateTime } = useCurrency();
const { entryTypeLabel, entryBadgeClass } = useLedgerLabel();

const balanceArs = ref<string | null>(null);
const loadingBalance = ref(false);

// Positive balance = client owes money → destructive (overdue) indicator.
const balancePositive = computed(() => {
  if (balanceArs.value == null) return false;
  return parseFloat(balanceArs.value) > 0;
});

const entries = ref<LedgerEntry[]>([]);
const loadingEntries = ref(false);
const page = ref(1);
const limit = 25;
const hasMore = ref(false);

async function load() {
  if (!auth.user) return;
  const id = auth.user.id;

  loadingBalance.value = true;
  loadingEntries.value = true;

  const [balRes, ledRes] = await Promise.all([
    getBalance(id),
    getLedger(id, page.value, limit),
  ]);

  loadingBalance.value = false;
  loadingEntries.value = false;

  if (balRes.ok) balanceArs.value = balRes.data.balance_ars;
  if (ledRes.ok) {
    entries.value = ledRes.data;
    hasMore.value = ledRes.data.length >= limit;
  }
}

async function loadMore() {
  if (!auth.user) return;
  page.value += 1;
  loadingEntries.value = true;
  const res = await getLedger(auth.user.id, page.value, limit);
  loadingEntries.value = false;
  if (res.ok) {
    entries.value = [...entries.value, ...res.data];
    hasMore.value = res.data.length >= limit;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-8">
    <h1 class="text-2xl font-semibold">{{ t('nav.myBalance') }}</h1>

    <section :aria-label="t('portal.balanceSummaryLabel')">
      <div v-if="loadingBalance">
        <Skeleton :rows="1" />
      </div>
      <div
        v-else
        :class="[
          'rounded-xl border p-6',
          balancePositive
            ? 'border-red-200 bg-red-50'
            : 'border-green-200 bg-green-50',
        ]"
      >
        <p class="text-sm text-neutral">{{ t('portal.currentBalance') }}</p>
        <p
          :class="['mt-1 text-3xl font-bold tabular-nums', balancePositive ? 'text-destructive' : 'text-success']"
        >
          {{ balanceArs != null ? formatARS(balanceArs) : '—' }}
        </p>
        <p v-if="balancePositive" class="mt-2 text-sm text-destructive">
          {{ t('portal.balanceDue') }}
        </p>
        <p v-else class="mt-2 text-sm text-success">
          {{ t('portal.balanceOk') }}
        </p>
      </div>
    </section>

    <section :aria-label="t('portal.ledgerHeading')">
      <h2 class="mb-3 text-lg font-semibold">{{ t('portal.ledgerHeading') }}</h2>

      <div v-if="loadingEntries && entries.length === 0">
        <Skeleton :rows="5" />
      </div>

      <EmptyState
        v-else-if="!loadingEntries && entries.length === 0"
        :heading="t('portal.noLedgerHeading')"
        :body="t('portal.noLedgerBody')"
      />

      <div v-else class="overflow-x-auto rounded-lg border border-border">
        <table class="w-full text-sm">
          <thead class="border-b border-border bg-surface">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-neutral">{{ t('portal.type') }}</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-neutral">{{ t('portal.amount') }}</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-neutral">{{ t('portal.date') }}</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-neutral">{{ t('portal.detail') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="entry in entries"
              :key="entry.id"
              class="bg-card hover:bg-surface transition-colors"
            >
              <td class="px-4 py-3">
                <span
                  :class="['inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', entryBadgeClass(entry.entry_type)]"
                >
                  {{ entryTypeLabel(entry.entry_type) }}
                </span>
              </td>
              <td class="px-4 py-3 font-semibold tabular-nums">
                {{ formatARS(entry.amount_ars) }}
              </td>
              <td class="px-4 py-3 text-neutral">
                {{ formatDateTime(entry.created_at) }}
              </td>
              <td class="px-4 py-3 text-neutral">
                <!-- Interpolate, never v-html: backend text is untrusted (XSS guard). -->
                {{ entry.description ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="hasMore" class="mt-4 flex justify-center">
        <AppButton variant="neutral" :loading="loadingEntries" @click="loadMore">
          {{ t('portal.loadMore') }}
        </AppButton>
      </div>
    </section>
  </div>
</template>
