<script setup lang="ts">
// Read-only: the client never modifies the ledger; server scopes results to the caller.

import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { getBalance, getLedger } from '@/api/ledger';
import type { LedgerEntry } from '@/api/ledger';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import { LEDGER_SORT_FIELDS } from '@shared/ssot/list-sort';
import { useCurrency } from '@/composables/useCurrency';
import { useLedgerLabel } from '@/composables/useLedgerLabel';
import { useListQuerySync } from '@/composables/useListQuerySync';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import Pagination from '@/components/generic/Pagination.vue';
import SortableHeader from '@/components/shared/SortableHeader.vue';

const { t } = useI18n();
const auth = useAuthStore();
const { formatARS, formatDateTime } = useCurrency();
const { entryTypeLabel, entryBadgeClass, entryDescription } = useLedgerLabel();

const balanceArs = ref<string | null>(null);
const loadingBalance = ref(false);
// A failed load must never read as "nothing owed" — the client would conclude the account is settled.
const balanceFailed = ref(false);
const entriesFailed = ref(false);

// Positive balance = client owes money → destructive (overdue) indicator.
const balancePositive = computed(() => {
  if (balanceArs.value == null) return false;
  return parseFloat(balanceArs.value) > 0;
});

const entries = ref<LedgerEntry[]>([]);
const loadingEntries = ref(false);
const total = ref(0);

// The statement is shareable: the page and the chosen order live in the URL, so a reload lands on
// the same view rather than back at the top of the newest-first default.
const listQuery = useListQuerySync({
  onChange: load,
  sortableFields: () => LEDGER_SORT_FIELDS,
});
const { page, sort, dir } = listQuery;
const limit = computed(() => listQuery.limit.value ?? LIST_DEFAULT_LIMIT);

// A new column starts ascending; clicking the active one reverses it. Sorting restarts at page 1 —
// the entry that was on page 3 under the old order is not on page 3 under the new one.
function toggleSort(field: string) {
  if (sort.value === field) {
    dir.value = dir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sort.value = field;
    dir.value = 'asc';
  }
  page.value = 1;
  listQuery.commit();
}

function goToPage(p: number) {
  page.value = p;
  listQuery.commit();
}

async function load() {
  if (!auth.user) return;
  const id = auth.user.id;

  loadingBalance.value = true;
  loadingEntries.value = true;
  balanceFailed.value = false;
  entriesFailed.value = false;

  try {
    const [balRes, ledRes] = await Promise.all([
      getBalance(id),
      getLedger(id, page.value, limit.value, { sort: sort.value || undefined, dir: dir.value }),
    ]);

    if (balRes.ok) balanceArs.value = balRes.data.balance_ars;
    else {
      balanceArs.value = null;
      balanceFailed.value = true;
    }

    if (ledRes.ok) {
      entries.value = ledRes.data;
      total.value = ledRes.meta ? ledRes.meta.total : ledRes.data.length;
    } else {
      entries.value = [];
      total.value = 0;
      entriesFailed.value = true;
    }
  } finally {
    loadingBalance.value = false;
    loadingEntries.value = false;
  }
}

load();
</script>

<template>
  <div class="space-y-8">
    <h1 class="text-2xl font-semibold">{{ t('nav.myBalance') }}</h1>

    <section :aria-label="t('portal.balanceSummaryLabel')">
      <div v-if="loadingBalance">
        <Skeleton :rows="1" />
      </div>
      <div
        v-else-if="balanceFailed"
        role="alert"
        class="rounded-xl border border-border bg-surface p-6"
      >
        <p class="text-sm">{{ t('portal.currentBalance') }}</p>
        <p class="mt-1 text-lg font-semibold">{{ t('portal.balanceLoadError') }}</p>
        <p class="mt-2 text-sm text-neutral">{{ t('emptyState.loadErrorBody') }}</p>
      </div>
      <div
        v-else
        :class="[
          'rounded-xl border p-6',
          balancePositive
            ? 'border-destructive-tint-border bg-destructive-tint text-destructive-strong'
            : 'border-success-tint-border bg-success-tint text-success-strong',
        ]"
      >
        <p class="text-sm">{{ t('portal.currentBalance') }}</p>
        <p class="mt-1 text-3xl font-bold tabular-nums">
          {{ balanceArs != null ? formatARS(balanceArs) : t('generic.emptyValue') }}
        </p>
        <p v-if="balancePositive" class="mt-2 text-sm">
          {{ t('portal.balanceDue') }}
        </p>
        <p v-else class="mt-2 text-sm">
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
        v-else-if="entriesFailed && entries.length === 0"
        :heading="t('portal.ledgerLoadErrorHeading')"
        :body="t('emptyState.loadErrorBody')"
      />

      <EmptyState
        v-else-if="!loadingEntries && entries.length === 0"
        :heading="t('portal.noLedgerHeading')"
        :body="t('portal.noLedgerBody')"
      />

      <div v-else class="overflow-x-auto rounded-lg border border-border">
        <table class="w-full text-sm" :aria-label="t('portal.ledgerHeading')">
          <thead class="border-b border-border bg-surface">
            <tr class="text-xs text-neutral">
              <SortableHeader field="entry_type" :label="t('portal.type')" :active="sort" :dir="dir" @sort="toggleSort" />
              <SortableHeader field="amount_ars" :label="t('portal.amount')" :active="sort" :dir="dir" @sort="toggleSort" />
              <SortableHeader field="created_at" :label="t('portal.date')" :active="sort" :dir="dir" @sort="toggleSort" />
              <th scope="col" class="px-4 py-3 text-left text-xs font-semibold text-neutral">{{ t('portal.detail') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr
              v-for="entry in entries"
              :key="entry.id"
              class="virtualized-row bg-card hover:bg-surface transition-colors"
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
                {{ entryDescription(entry) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="entriesFailed && entries.length > 0" role="alert" class="mt-3 text-sm text-destructive">
        {{ t('portal.ledgerLoadErrorHeading') }}
      </p>

      <Pagination
        v-if="total > limit"
        :page="page"
        :limit="limit"
        :total="total"
        class="mt-2"
        @change="goToPage"
      />
    </section>
  </div>
</template>
