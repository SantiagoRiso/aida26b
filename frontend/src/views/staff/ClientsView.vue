<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { prefetchClientDetail } from '@/composables/clientDetailPrefetch';
import { listRows } from '@/api/crud';
import { listRelatedClientIds } from '@/api/appointments';
import { structure } from '@shared/ssot/structure';
import type { TableRecordMap } from '@shared/ssot/derived';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ClientDetail from '@/components/staff/ClientDetail.vue';
import CreateClientForm from '@/components/staff/CreateClientForm.vue';
import AppButton from '@/components/shared/AppButton.vue';

const { t } = useI18n();
const { success } = useToast();
const auth = useAuthStore();
const { label } = useLabel();

const clientColumns = structure.tables.clients.columns;

// The "prior relationship" scoping is only meaningful for staff whose client list is a subset
// (Professional/Receptionist): an Admin sees every client, all of them relevant.
const isAdmin = computed(() => auth.user?.role === 'Admin');

const clients = ref<TableRecordMap['clients'][]>([]);
// Clients with a prior relationship = at least one appointment in the viewer-scoped list
// (for a Professional that list is already limited to their own appointments).
// Keyed by string id — the API serializes ids as strings.
const relatedIds = ref<Set<string>>(new Set());
const loading = ref(true);

const nameQuery = ref('');
const includeUnrelated = ref(false);

const filtered = computed(() => {
  const q = nameQuery.value.trim().toLowerCase();
  return clients.value.filter((c) => {
    if (!isAdmin.value && !includeUnrelated.value && !relatedIds.value.has(String(c.id))) return false;
    if (q) {
      const matchesName = c.display_name.toLowerCase().includes(q);
      const matchesDni = (c.dni ?? '').toLowerCase().includes(q);
      if (!matchesName && !matchesDni) return false;
    }
    return true;
  });
});

async function load() {
  loading.value = true;
  const [clientsRes, relatedRes] = await Promise.all([
    listRows('clients', { limit: 500, sort: 'display_name', dir: 'asc' }),
    listRelatedClientIds(),
  ]);
  if (clientsRes.ok) clients.value = clientsRes.data;
  if (relatedRes.ok) relatedIds.value = new Set(relatedRes.data.map((id) => String(id)));
  loading.value = false;
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
        v-model="nameQuery"
        type="search"
        :placeholder="t('clients.searchPlaceholder')"
        class="w-64 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <label v-if="!isAdmin" class="flex items-center gap-2 text-sm text-neutral">
        <input type="checkbox" v-model="includeUnrelated" class="accent-accent" />
        {{ t('clients.includeUnrelated') }}
      </label>
    </div>

    <div v-if="loading">
      <Skeleton variant="row" :rows="6" />
    </div>

    <div v-else-if="filtered.length === 0">
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
            <th class="px-4 py-3 font-semibold">{{ label(clientColumns.display_name.label) }}</th>
            <th class="px-4 py-3 font-semibold">{{ label(clientColumns.dni.label) }}</th>
            <th class="px-4 py-3 font-semibold">{{ label(clientColumns.email.label) }}</th>
            <th class="px-4 py-3 font-semibold">{{ label(clientColumns.phone.label) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in filtered"
            :key="c.id"
            class="virtualized-row border-t border-border hover:bg-surface cursor-pointer"
            @pointerenter="prefetchClient(Number(c.id))"
            @focusin="prefetchClient(Number(c.id))"
            @click="openClient(Number(c.id))"
          >
            <td class="px-4 py-3 font-medium">
              {{ c.display_name }}
              <span
                v-if="!isAdmin && !relatedIds.has(String(c.id))"
                class="ml-2 rounded-full bg-border px-2 py-0.5 text-xs font-normal text-neutral"
              >
                {{ t('clients.noRelationship') }}
              </span>
            </td>
            <td class="px-4 py-3 text-neutral">{{ c.dni ?? '—' }}</td>
            <td class="px-4 py-3 text-neutral">{{ c.email ?? '—' }}</td>
            <td class="px-4 py-3 text-neutral">{{ c.phone ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

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
