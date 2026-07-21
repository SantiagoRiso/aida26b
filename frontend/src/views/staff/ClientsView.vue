<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { useListQuerySync } from '@/composables/useListQuerySync';
import { prefetchClientDetail } from '@/composables/clientDetailPrefetch';
import { listRows } from '@/api/crud';
import { listRelatedClientIds } from '@/api/appointments';
import { structure } from '@shared/ssot/structure';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ClientDetail from '@/components/staff/ClientDetail.vue';
import CreateClientForm from '@/components/staff/CreateClientForm.vue';
import AppButton from '@/components/shared/AppButton.vue';
import Pagination from '@/components/generic/Pagination.vue';

const { t } = useI18n();
const { success } = useToast();
const auth = useAuthStore();
const { label } = useLabel();

const clientColumns = structure.tables.clients.columns;

// Columns rendered as a table, in display order.
const LIST_COLUMNS = ['display_name', 'dni', 'email', 'phone'] as const;
// The two columns the search box pair queries. Both must stay declared filterable in the
// descriptor for the server to honour them.
const SEARCH_COLUMNS = ['display_name', 'dni'] as const;

const DEFAULT_SORT = 'display_name';

// The "prior relationship" scoping is only meaningful for staff whose client list is a subset
// (Professional/Receptionist): an Admin sees every client, all of them relevant.
const isAdmin = computed(() => auth.user?.role === 'Admin');

const clients = ref<Wire<TableRecordMap['clients']>[]>([]);
// Only the badge needs this: which of the rows on screen the viewer has no history with. The
// narrowing itself is the server's. Keyed by string id — the API serializes ids as strings.
const relatedIds = ref<Set<string>>(new Set());
const loading = ref(true);
const total = ref(0);
// The server owns the page size; this only seeds the render before the first response lands.
const limit = ref(LIST_DEFAULT_LIMIT);

// Filters, sort, page and the relationship toggle live in the URL under the shared list
// vocabulary, so a search can be reloaded or shared. Search is server-side: the whole client
// list is never in memory.
const listQuery = useListQuerySync({
  onChange: () => { void load(); },
  sortableFields: () => LIST_COLUMNS.filter((key) => clientColumns[key].sortable),
  filterableFields: () => [...SEARCH_COLUMNS],
  defaultFilters: () => ({ display_name: '', dni: '' }),
});
const { page, sort, dir, filters, includeUnrelated } = listQuery;

const activeSort = computed(() => sort.value || DEFAULT_SORT);

function toggleSort(field: string) {
  if (activeSort.value === field) {
    dir.value = dir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sort.value = field;
    dir.value = 'asc';
  }
  listQuery.commit();
}

function onSearchInput() {
  page.value = 1;
  listQuery.commitDebounced();
}

function goToPage(next: number) {
  page.value = next;
  listQuery.commit();
}

function onIncludeUnrelatedChange() {
  page.value = 1;
  listQuery.commit();
}

async function loadClients() {
  loading.value = true;
  const result = await listRows('clients', {
    page: page.value,
    limit: listQuery.limit.value,
    sort: activeSort.value,
    dir: dir.value,
    filters: filters.value,
    includeUnrelated: includeUnrelated.value,
  });
  if (result.ok) {
    clients.value = result.data;
    total.value = result.meta?.total ?? result.data.length;
    limit.value = result.meta?.limit ?? LIST_DEFAULT_LIMIT;
  }
  loading.value = false;
}

// Relatedness is a property of the viewer, not of the page — fetched once, not per page. Only
// needed while unrelated clients are on screen, to tell them apart.
const relatedIdsLoaded = ref(false);
async function loadRelatedIds() {
  if (isAdmin.value || !includeUnrelated.value || relatedIdsLoaded.value) return;
  const result = await listRelatedClientIds();
  if (!result.ok) return;
  relatedIds.value = new Set(result.data.map((id) => String(id)));
  relatedIdsLoaded.value = true;
}

// Every row is related unless the viewer asked for the wider list, so the badge only means
// something once that set is known.
const showsRelationship = computed(() => !isAdmin.value && includeUnrelated.value && relatedIdsLoaded.value);

async function load() {
  await Promise.all([loadClients(), loadRelatedIds()]);
}

const selectedClientId = ref<number | null>(null);
const clientOpen = ref(false);
function openClient(id: number) {
  selectedClientId.value = id;
  clientOpen.value = true;
}

// Staff-registered clients (walk-ins, phone bookings); the route already limits
// this view to Admin/Professional/Receptionist, and the server re-checks the role.
const createPanelOpen = ref(false);

function openCreate() {
  createPanelOpen.value = true;
}

async function onClientCreated() {
  createPanelOpen.value = false;
  success('saved');
  await load();
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{{ t('nav.clients') }}</h1>
      <AppButton @click="openCreate">
        {{ t('clients.addClient') }}
      </AppButton>
    </div>

    <div class="flex flex-wrap items-center gap-4">
      <input
        v-for="field in SEARCH_COLUMNS"
        :key="field"
        v-model="filters[field]"
        type="search"
        :aria-label="label(clientColumns[field].label)"
        :placeholder="label(clientColumns[field].label)"
        class="w-48 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        @input="onSearchInput"
      />
      <label v-if="!isAdmin" class="flex items-center gap-2 text-sm text-neutral">
        <input
          type="checkbox"
          v-model="includeUnrelated"
          class="accent-accent"
          @change="onIncludeUnrelatedChange"
        />
        {{ t('clients.includeUnrelated') }}
      </label>
    </div>

    <div v-if="loading">
      <Skeleton variant="row" :rows="6" />
    </div>

    <div v-else-if="clients.length === 0">
      <EmptyState
        :heading="t('clients.emptyHeading')"
        :body="(includeUnrelated || isAdmin)
          ? t('clients.emptySearchBody')
          : t('clients.emptyUnrelatedBody')"
      />
    </div>

    <div v-else class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="bg-surface text-left">
          <tr>
            <th
              v-for="field in LIST_COLUMNS"
              :key="field"
              class="px-4 py-3 font-semibold"
              :class="clientColumns[field].sortable ? 'cursor-pointer select-none hover:bg-border' : ''"
              @click="clientColumns[field].sortable ? toggleSort(field) : undefined"
            >
              {{ label(clientColumns[field].label) }}
              <span v-if="clientColumns[field].sortable && activeSort === field" class="ml-1 text-xs text-neutral">
                {{ dir === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in clients"
            :key="c.id"
            class="virtualized-row border-t border-border hover:bg-surface cursor-pointer"
            @pointerenter="prefetchClientDetail(Number(c.id))"
            @focusin="prefetchClientDetail(Number(c.id))"
            @click="openClient(Number(c.id))"
          >
            <td class="px-4 py-3 font-medium">
              {{ c.display_name }}
              <span
                v-if="showsRelationship && !relatedIds.has(String(c.id))"
                class="ml-2 rounded-full bg-border px-2 py-0.5 text-xs font-normal text-neutral"
              >
                {{ t('clients.noRelationship') }}
              </span>
            </td>
            <td class="px-4 py-3 text-neutral">{{ c.dni ?? t('generic.emptyValue') }}</td>
            <td class="px-4 py-3 text-neutral">{{ c.email ?? t('generic.emptyValue') }}</td>
            <td class="px-4 py-3 text-neutral">{{ c.phone ?? t('generic.emptyValue') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Pagination
      v-if="!loading && (total > limit || page > 1)"
      :page="page"
      :limit="limit"
      :total="total"
      @change="goToPage"
    />

    <DetailPanel
      :open="clientOpen"
      size="7xl"
      :title="t('clients.detailTitle')"
      @close="clientOpen = false"
      @after-leave="selectedClientId = null"
    >
      <ClientDetail
        v-if="selectedClientId !== null"
        :client-id="selectedClientId"
        @close="clientOpen = false"
        @changed="load"
      />
    </DetailPanel>

    <DetailPanel
      :open="createPanelOpen"
      :title="t('clients.newClient')"
      @close="createPanelOpen = false"
    >
      <CreateClientForm @created="onClientCreated" @cancel="createPanelOpen = false" />
    </DetailPanel>
  </div>
</template>
