<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { listAudit } from '@/api/audit';
import type { AuditEvent } from '@/api/audit';
import { AUDIT_OUTCOMES } from '@shared/ssot/domain';
import { structure } from '@shared/ssot/structure';
import type { TableStructure } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import { useCurrency } from '@/composables/useCurrency';
import { useLabel } from '@/composables/useLabel';
import { auditOutcomeBadgeClass } from '@/composables/badgeTone';
import { useAuthStore } from '@/stores/auth';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Pagination from '@/components/generic/Pagination.vue';
import DateField from '@/components/shared/DateField.vue';

const { t } = useI18n();
const auth = useAuthStore();
const { formatDateTime } = useCurrency();
const { label } = useLabel();

// Route meta already gates access; render nothing if somehow reached as non-Admin.
const isAdmin = computed(() => auth.user?.role === 'Admin');

const events = ref<AuditEvent[]>([]);
const loading = ref(false);
const page = ref(1);
const limit = 50;
const total = ref(0);

const filterEntityType = ref('');
const filterActorId = ref('');
const filterEventType = ref('');
const filterDateFrom = ref('');
const filterDateTo = ref('');
const filterOutcome = ref('');

// Labels restate SSOT table titles rather than repeating them — the filter value (what the
// backend expects in entity_type) stays independent of the SSOT table key used for display.
const ENTITY_TYPES: Array<{ value: string; tableKey?: TableKey }> = [
  { value: '' },
  { value: 'appointments', tableKey: 'appointments' },
  { value: 'ledger_entries', tableKey: 'ledger_entries' },
  { value: 'auth.users', tableKey: 'users' },
  { value: 'businesses', tableKey: 'businesses' },
  { value: 'calendar_grants', tableKey: 'calendar_grants' },
];

function entityTypeLabel(opt: { value: string; tableKey?: TableKey }): string {
  if (!opt.tableKey) return t('audit.allTypes');
  // Widened to TableStructure: indexing by the generic TableKey union loses the per-table
  // literal type, which makes the optional `title` member inaccessible (mirrors GenericTable.vue).
  return label((structure.tables[opt.tableKey] as TableStructure).title);
}

const OUTCOMES = AUDIT_OUTCOMES;

async function load() {
  if (!isAdmin.value) return;
  loading.value = true;
  const result = await listAudit(
    {
      entity_type: filterEntityType.value || undefined,
      actor_user_id: filterActorId.value ? Number(filterActorId.value) : undefined,
      event_type: filterEventType.value || undefined,
      date_from: filterDateFrom.value || undefined,
      date_to: filterDateTo.value || undefined,
      outcome: filterOutcome.value || undefined,
    },
    page.value,
    limit,
  );
  if (result.ok) {
    events.value = result.data;
    if (result.meta) total.value = result.meta.total;
  }
  loading.value = false;
}

function applyFilters() {
  page.value = 1;
  load();
}

function resetFilters() {
  filterEntityType.value = '';
  filterActorId.value = '';
  filterEventType.value = '';
  filterDateFrom.value = '';
  filterDateTo.value = '';
  filterOutcome.value = '';
  applyFilters();
}

if (isAdmin.value) {
  load();
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-6">
      {{ t('audit.title') }}
    </h1>

    <template v-if="!isAdmin">
      <EmptyState
        :heading="t('audit.accessRestrictedHeading')"
        :body="t('audit.accessRestrictedBody')"
      />
    </template>

    <template v-else>
      <form class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" @submit.prevent="applyFilters">
        <select
          v-model="filterEntityType"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          :aria-label="t('audit.entityTypeAria')"
        >
          <option
            v-for="opt in ENTITY_TYPES"
            :key="opt.value"
            :value="opt.value"
          >
            {{ entityTypeLabel(opt) }}
          </option>
        </select>

        <input
          v-model="filterActorId"
          type="number"
          min="1"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          :placeholder="t('audit.actorIdPlaceholder')"
        />

        <input
          v-model="filterEventType"
          type="text"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          :placeholder="t('audit.eventTypePlaceholder')"
        />

        <div class="flex items-center gap-2">
          <label for="audit-date-from" class="text-xs font-semibold text-neutral shrink-0">
            {{ t('generic.from') }}
          </label>
          <DateField id="audit-date-from" v-model="filterDateFrom" />
        </div>

        <div class="flex items-center gap-2">
          <label for="audit-date-to" class="text-xs font-semibold text-neutral shrink-0">
            {{ t('generic.to') }}
          </label>
          <DateField id="audit-date-to" v-model="filterDateTo" />
        </div>

        <select
          v-model="filterOutcome"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          :aria-label="t('audit.outcome')"
        >
          <option value="">{{ t('generic.all') }}</option>
          <option
            v-for="opt in OUTCOMES"
            :key="opt.value"
            :value="opt.value"
          >
            {{ label(opt.label) }}
          </option>
        </select>

        <div class="flex gap-2 xl:col-span-6 justify-end">
          <AppButton variant="neutral" type="button" @click="resetFilters">
            {{ t('audit.clear') }}
          </AppButton>
          <AppButton variant="primary" type="submit" :loading="loading">
            {{ t('audit.search') }}
          </AppButton>
        </div>
      </form>

      <div v-if="loading">
        <Skeleton variant="row" :rows="8" />
      </div>

      <div v-else-if="events.length === 0">
        <EmptyState
          :heading="t('audit.emptyHeading')"
          :body="t('audit.emptyBody')"
        />
      </div>

      <div v-else class="overflow-x-auto rounded-lg border border-border">
        <table class="min-w-full divide-y divide-border text-sm">
          <thead class="bg-surface">
            <tr>
              <th class="px-4 py-3 text-left font-semibold text-heading whitespace-nowrap">
                {{ t('calendar.dateLabel') }}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-heading whitespace-nowrap">
                {{ t('audit.colEvent') }}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-heading whitespace-nowrap">
                {{ t('audit.colEntity') }}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-heading whitespace-nowrap">
                {{ t('audit.colActor') }}
              </th>
              <th class="px-4 py-3 text-left font-semibold text-heading whitespace-nowrap">
                {{ t('audit.outcome') }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border bg-card">
            <tr
              v-for="event in events"
              :key="event.id"
              class="virtualized-row hover:bg-surface"
              :class="{ 'bg-red-50': event.outcome === 'denied' }"
            >
              <td class="px-4 py-3 tabular-nums text-neutral whitespace-nowrap">
                {{ formatDateTime(event.created_at) }}
              </td>
              <td class="px-4 py-3 font-mono text-xs text-heading">
                {{ event.event_type }}
              </td>
              <td class="px-4 py-3 text-neutral">
                {{ event.entity_type }}
                <span v-if="event.entity_id" class="ml-1 text-xs opacity-60">#{{ event.entity_id }}</span>
              </td>
              <td class="px-4 py-3 tabular-nums text-neutral">
                {{ event.actor_user_id ?? '—' }}
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                  :class="auditOutcomeBadgeClass(event.outcome)"
                >
                  <span v-if="event.outcome === 'denied'" class="mr-1" aria-hidden="true">⛔</span>
                  {{ event.outcome }}
                </span>
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
        @change="(p) => { page = p; load(); }"
      />
    </template>
  </div>
</template>
