<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { listAudit } from '@/api/audit';
import type { AuditEvent } from '@/api/audit';
import { AUDIT_OUTCOMES } from '@shared/ssot/domain';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import { AUDIT_SORT_FIELDS } from '@shared/ssot/list-sort';
import { structure } from '@shared/ssot/structure';
import type { TableStructure } from '@shared/types/types';
import type { TableKey } from '@shared/ssot/derived';
import { isTableKey } from '@shared/utils/utils';
import { useCurrency } from '@/composables/useCurrency';
import { useLabel } from '@/composables/useLabel';
import { useListQuerySync } from '@/composables/useListQuerySync';
import { auditOutcomeBadgeClass } from '@/composables/badgeTone';
import { useAuthStore } from '@/stores/auth';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Pagination from '@/components/generic/Pagination.vue';
import DateField from '@/components/shared/DateField.vue';
import SortableHeader from '@/components/shared/SortableHeader.vue';

const { t } = useI18n();
const auth = useAuthStore();
const { formatDateTime } = useCurrency();
const { label } = useLabel();

// Route meta already gates access; render nothing if somehow reached as non-Admin.
const isAdmin = computed(() => auth.user?.role === 'Admin');
// A super-admin (Admin with no business) reads across tenants, so it needs the tenant column to
// tell the merged rows apart; a tenant Admin sees one business and the column would be noise.
const isSuperAdmin = computed(() => auth.user?.role === 'Admin' && auth.user?.business_id == null);

const events = ref<AuditEvent[]>([]);
const loading = ref(false);
const loadFailed = ref(false);
const total = ref(0);

// created_at carries the shared `min,max` date range; the two date pickers edit its two halves.
const BLANK_FILTERS = {
  entity_type: '',
  actor_username: '',
  event_type: '',
  created_at: '',
  outcome: '',
};

function splitRange(range: string): { from: string; to: string } {
  const comma = range.indexOf(',');
  if (comma < 0) return { from: range, to: '' };
  return { from: range.slice(0, comma), to: range.slice(comma + 1) };
}

function joinRange(from: string, to: string): string {
  return from === '' && to === '' ? '' : `${from},${to}`;
}

// The search is shareable: filters and page live in the URL under the same list-request
// vocabulary every other list uses.
const listQuery = useListQuerySync({
  onChange: load,
  sortableFields: () => AUDIT_SORT_FIELDS,
  filterableFields: () => Object.keys(BLANK_FILTERS),
  defaultFilters: () => ({ ...BLANK_FILTERS }),
});
const { page, filters, sort, dir } = listQuery;

// The two pickers write into one created_at range so the URL and the request carry a single
// filter_created_at param, not two ad-hoc date keys.
const dateFrom = computed<string>({
  get: () => splitRange(filters.value.created_at ?? '').from,
  set: (v) => {
    const { to } = splitRange(filters.value.created_at ?? '');
    filters.value = { ...filters.value, created_at: joinRange(v, to) };
  },
});
const dateTo = computed<string>({
  get: () => splitRange(filters.value.created_at ?? '').to,
  set: (v) => {
    const { from } = splitRange(filters.value.created_at ?? '');
    filters.value = { ...filters.value, created_at: joinRange(from, v) };
  },
});

// A new column starts ascending; clicking the active one reverses it. Sorting restarts at page 1 —
// the row that was on page 3 under the old order is not on page 3 under the new one.
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
const limit = computed(() => listQuery.limit.value ?? LIST_DEFAULT_LIMIT);

// Labels restate SSOT table titles rather than repeating them — the filter value (what the
// backend expects in entity_type) stays independent of the SSOT table key used for display.
// The types worth offering, not every type that occurs: generic CRUD stamps the table key of any
// non-protected table, so services and the join tables also appear in the log and simply have no
// option here. `businesses` was removed because it is protected — no generic CRUD writes it and no
// bespoke route names it — so offering it asked for a set that is always empty.
const ENTITY_TYPES: Array<{ value: string; tableKey?: TableKey }> = [
  { value: '' },
  { value: 'appointments', tableKey: 'appointments' },
  { value: 'ledger_entries', tableKey: 'ledger_entries' },
  { value: 'auth.users', tableKey: 'users' },
  { value: 'calendar_grants', tableKey: 'calendar_grants' },
  { value: 'schedule_exceptions', tableKey: 'schedule_exceptions' },
];

function entityTypeLabel(opt: { value: string; tableKey?: TableKey }): string {
  if (!opt.tableKey) return t('audit.allTypes');
  // Widened to TableStructure: indexing by the generic TableKey union loses the per-table
  // literal type, which makes the optional `title` member inaccessible (mirrors GenericTable.vue).
  return label((structure.tables[opt.tableKey] as TableStructure).title);
}

const OUTCOMES = AUDIT_OUTCOMES;

// The id stands in when a purged actor leaves the username unresolvable — an audit row must stay
// readable. No actor at all is the system acting on its own.
function actorLabel(event: AuditEvent): string {
  if (event.actor_username != null) return event.actor_username;
  if (event.actor_user_id != null) return `#${event.actor_user_id}`;
  return t('generic.emptyValue');
}

// The entity reads like the actor does: a name, not a table name and a number. Generic writes stamp
// the table key itself, so an unresolved entity still falls back to that table's own title rather
// than its SQL name. auth.users is the one entity whose stamped value is not a table key.
function entityKindLabel(entityType: string): string {
  const key = entityType === 'auth.users' ? 'users' : entityType;
  return isTableKey(key) ? label((structure.tables[key] as TableStructure).title) : entityType;
}

function entityLabel(event: AuditEvent): string {
  if (event.entity_label != null) return event.entity_label;
  if (event.entity_type != null) return entityKindLabel(event.entity_type);
  return t('generic.emptyValue');
}

// The locator the name replaced, kept on hover: reading the log is a human question, but chasing a
// specific record afterwards still needs the id.
function entityDetail(event: AuditEvent): string {
  if (event.entity_type == null) return '';
  return event.entity_id != null ? `${event.entity_type} #${event.entity_id}` : event.entity_type;
}

async function load() {
  if (!isAdmin.value) return;
  loading.value = true;
  loadFailed.value = false;
  const active = filters.value;
  const result = await listAudit(
    {
      entity_type: active.entity_type || undefined,
      actor_username: active.actor_username || undefined,
      event_type: active.event_type || undefined,
      created_at: active.created_at || undefined,
      outcome: active.outcome || undefined,
    },
    page.value,
    limit.value,
    { sort: sort.value || undefined, dir: dir.value },
  );
  if (result.ok) {
    events.value = result.data;
    total.value = result.meta ? result.meta.total : 0;
  } else {
    // A failed load must not read as "no events" — that hides the failure and misreports the record.
    events.value = [];
    total.value = 0;
    loadFailed.value = true;
  }
  loading.value = false;
}

function applyFilters() {
  page.value = 1;
  listQuery.commit();
}

function resetFilters() {
  filters.value = { ...BLANK_FILTERS };
  applyFilters();
}

function goToPage(p: number) {
  page.value = p;
  listQuery.commit();
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
          v-model="filters.entity_type"
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
          v-model="filters.actor_username"
          type="text"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          :placeholder="t('audit.actorPlaceholder')"
        />

        <input
          v-model="filters.event_type"
          type="text"
          class="rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          :placeholder="t('audit.eventTypePlaceholder')"
        />

        <div class="flex items-center gap-2">
          <label for="audit-date-from" class="text-xs font-semibold text-neutral shrink-0">
            {{ t('generic.from') }}
          </label>
          <DateField id="audit-date-from" v-model="dateFrom" />
        </div>

        <div class="flex items-center gap-2">
          <label for="audit-date-to" class="text-xs font-semibold text-neutral shrink-0">
            {{ t('generic.to') }}
          </label>
          <DateField id="audit-date-to" v-model="dateTo" />
        </div>

        <select
          v-model="filters.outcome"
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

      <div v-else-if="loadFailed">
        <EmptyState
          :heading="t('audit.errorHeading')"
          :body="t('audit.errorBody')"
        />
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
            <tr class="text-heading">
              <th v-if="isSuperAdmin" scope="col" class="px-4 py-3 text-left font-semibold">
                {{ t('nav.business') }}
              </th>
              <SortableHeader field="created_at" :label="t('calendar.dateLabel')" :active="sort" :dir="dir" @sort="toggleSort" />
              <SortableHeader field="event_type" :label="t('audit.colEvent')" :active="sort" :dir="dir" @sort="toggleSort" />
              <SortableHeader field="entity_type" :label="t('audit.colEntity')" :active="sort" :dir="dir" @sort="toggleSort" />
              <SortableHeader field="actor_username" :label="t('audit.colActor')" :active="sort" :dir="dir" @sort="toggleSort" />
              <SortableHeader field="outcome" :label="t('audit.outcome')" :active="sort" :dir="dir" @sort="toggleSort" />
            </tr>
          </thead>
          <tbody class="divide-y divide-border bg-card">
            <tr
              v-for="event in events"
              :key="event.id"
              class="virtualized-row hover:bg-surface"
              :class="{
                'bg-destructive-tint [&>td]:text-destructive-strong': event.outcome === 'denied',
              }"
            >
              <td v-if="isSuperAdmin" class="px-4 py-3 text-neutral whitespace-nowrap">
                <span v-if="event.business_id != null" class="tabular-nums">#{{ event.business_id }}</span>
                <span v-else class="text-xs uppercase tracking-wide opacity-70">{{ t('audit.systemActor') }}</span>
              </td>
              <td class="px-4 py-3 tabular-nums text-neutral whitespace-nowrap">
                {{ formatDateTime(event.created_at) }}
              </td>
              <td class="px-4 py-3 font-mono text-xs text-heading">
                {{ event.event_type }}
              </td>
              <td class="px-4 py-3 text-neutral">
                <span :title="entityDetail(event)">
                  {{ entityLabel(event) }}
                  <!-- A title attribute is mouse-only: no keyboard focus, nothing on touch. The
                       locator is repeated for assistive tech so hiding it from sight never means
                       hiding it from a reader. -->
                  <span v-if="entityDetail(event)" class="sr-only">{{ entityDetail(event) }}</span>
                </span>
              </td>
              <td class="px-4 py-3 text-neutral">
                {{ actorLabel(event) }}
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
        @change="goToPage"
      />
    </template>
  </div>
</template>
