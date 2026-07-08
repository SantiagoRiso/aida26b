<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { listRows } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ClientDetail from '@/components/staff/ClientDetail.vue';

const { label } = useLabel();

interface ClientRow {
  id: number;
  display_name: string;
  email: string | null;
  phone: string | null;
  dni: string | null;
}

const clients = ref<ClientRow[]>([]);
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
    if (!includeUnrelated.value && !relatedIds.value.has(String(c.id))) return false;
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
  const [clientsRes, apptRes] = await Promise.all([
    listRows<ClientRow>('clients', { limit: 500, sort: 'display_name', dir: 'asc' }),
    listAppointments({ limit: 500 }),
  ]);
  if (clientsRes.ok) clients.value = clientsRes.data;
  if (apptRes.ok) {
    const ids = new Set<string>();
    for (const a of apptRes.data) if (a.client_user_id != null) ids.add(String(a.client_user_id));
    relatedIds.value = ids;
  }
  loading.value = false;
}

const selectedClientId = ref<number | null>(null);
const clientOpen = ref(false);
function openClient(id: number) {
  selectedClientId.value = id;
  clientOpen.value = true;
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-semibold">{{ label({ es: 'Clientes', en: 'Clients' }) }}</h1>

    <div class="flex flex-wrap items-center gap-4">
      <input
        v-model="nameQuery"
        type="search"
        :placeholder="label({ es: 'Buscar por nombre o DNI…', en: 'Search by name or DNI…' })"
        class="w-64 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <label class="flex items-center gap-2 text-sm text-neutral">
        <input type="checkbox" v-model="includeUnrelated" class="accent-accent" />
        {{ label({ es: 'Incluir clientes sin relación previa', en: 'Include clients with no prior relationship' }) }}
      </label>
    </div>

    <div v-if="loading">
      <Skeleton variant="row" :rows="6" />
    </div>

    <div v-else-if="filtered.length === 0">
      <EmptyState
        :heading="label({ es: 'No hay clientes para mostrar', en: 'No clients to show' })"
        :body="includeUnrelated
          ? label({ es: 'Probá ajustar la búsqueda.', en: 'Try adjusting your search.' })
          : label({ es: 'No hay clientes con relación previa. Marcá la casilla para ver todos.', en: 'No clients with a prior relationship. Tick the box to see all.' })"
      />
    </div>

    <div v-else class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full text-sm">
        <thead class="bg-surface text-left">
          <tr>
            <th class="px-4 py-3 font-semibold">{{ label({ es: 'Nombre', en: 'Name' }) }}</th>
            <th class="px-4 py-3 font-semibold">{{ label({ es: 'DNI', en: 'DNI' }) }}</th>
            <th class="px-4 py-3 font-semibold">{{ label({ es: 'Email', en: 'Email' }) }}</th>
            <th class="px-4 py-3 font-semibold">{{ label({ es: 'Teléfono', en: 'Phone' }) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in filtered"
            :key="c.id"
            class="border-t border-border hover:bg-surface cursor-pointer"
            @click="openClient(c.id)"
          >
            <td class="px-4 py-3 font-medium">
              {{ c.display_name }}
              <span
                v-if="!relatedIds.has(String(c.id))"
                class="ml-2 rounded-full bg-border px-2 py-0.5 text-xs font-normal text-neutral"
              >
                {{ label({ es: 'sin relación', en: 'no relationship' }) }}
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
      :title="label({ es: 'Detalle del cliente', en: 'Client detail' })"
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
  </div>
</template>
