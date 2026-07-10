<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { useToast } from '@/composables/useToast';
import { listRows } from '@/api/crud';
import { listRelatedClientIds } from '@/api/appointments';
import { createUser } from '@/api/admin-users';
import type { TableRecordMap } from '@shared/types/types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ClientDetail from '@/components/staff/ClientDetail.vue';
import FieldError from '@/components/shared/FieldError.vue';
import AppButton from '@/components/shared/AppButton.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';

const { label } = useLabel();
const { success } = useToast();

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
const createSubmitting = ref(false);
const createError = ref('');
const createForm = reactive({
  username: '',
  password: '',
  display_name: '',
  email: '',
  dni: '',
});

function openCreate() {
  Object.assign(createForm, { username: '', password: '', display_name: '', email: '', dni: '' });
  createError.value = '';
  createPanelOpen.value = true;
}

async function submitCreate() {
  createSubmitting.value = true;
  createError.value = '';
  try {
    const result = await createUser({
      username: createForm.username,
      password: createForm.password,
      role: 'Client',
      display_name: createForm.display_name || undefined,
      email: createForm.email || undefined,
      dni: createForm.dni || undefined,
    });
    if (result.ok) {
      createPanelOpen.value = false;
      success('saved');
      await load();
    } else {
      createError.value = result.message ?? label({ es: 'Error creando cliente', en: 'Error creating client' });
    }
  } finally {
    createSubmitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{{ label({ es: 'Clientes', en: 'Clients' }) }}</h1>
      <AppButton @click="openCreate">
        {{ label({ es: 'Agregar cliente', en: 'Add client' }) }}
      </AppButton>
    </div>

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
            @click="openClient(Number(c.id))"
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

    <DetailPanel
      :open="createPanelOpen"
      :title="label({ es: 'Nuevo cliente', en: 'New client' })"
      @close="createPanelOpen = false"
    >
      <form class="space-y-4" @submit.prevent="submitCreate" novalidate>
        <FieldError :message="createError" />

        <div class="flex flex-col gap-1">
          <label for="client-username" class="text-sm font-semibold">
            {{ label({ es: 'Usuario', en: 'Username' }) }} <span class="text-destructive">*</span>
          </label>
          <input
            id="client-username"
            v-model="createForm.username"
            type="text"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="client-password" class="text-sm font-semibold">
            {{ label({ es: 'Contraseña', en: 'Password' }) }} <span class="text-destructive">*</span>
          </label>
          <PasswordInput
            id="client-password"
            v-model="createForm.password"
            input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            required
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="client-display-name" class="text-sm font-semibold">
            {{ label({ es: 'Nombre visible', en: 'Display name' }) }}
          </label>
          <input
            id="client-display-name"
            v-model="createForm.display_name"
            type="text"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="client-email" class="text-sm font-semibold">{{ label({ es: 'Email', en: 'Email' }) }}</label>
          <input
            id="client-email"
            v-model="createForm.email"
            type="email"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="client-dni" class="text-sm font-semibold">{{ label({ es: 'DNI', en: 'DNI' }) }}</label>
          <input
            id="client-dni"
            v-model="createForm.dni"
            type="text"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <AppButton variant="neutral" type="button" @click="createPanelOpen = false">
            {{ label({ es: 'Cancelar', en: 'Cancel' }) }}
          </AppButton>
          <AppButton type="submit" :loading="createSubmitting">
            {{ label({ es: 'Guardar', en: 'Save' }) }}
          </AppButton>
        </div>
      </form>
    </DetailPanel>
  </div>
</template>
