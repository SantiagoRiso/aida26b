<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { listRows } from '@/api/crud';
import { colorForProfessional, scopeProfessionalOptions } from '@/composables/useFullCalendar';
import { useAuthStore } from '@/stores/auth';

const { t } = useI18n();
const auth = useAuthStore();

export interface FilterState {
  professional_user_id: number | null;
  resource_id: number | null;
}

const emit = defineEmits<{
  'update:filters': [filters: FilterState];
}>();

interface Option {
  id: number;
  label: string;
}

const professionals = ref<Option[]>([]);
const resources = ref<Option[]>([]);
const selectedProfessional = ref<number | null>(null);
const selectedResource = ref<number | null>(null);

onMounted(async () => {
  const [profResult, resResult] = await Promise.all([
    listRows('professionals', { limit: 200 }),
    listRows('resources', { limit: 200 }),
  ]);
  if (profResult.ok) {
    const options = profResult.data.map((p) => ({
      id: Number(p.id),
      label: p.display_name,
    }));
    professionals.value = scopeProfessionalOptions(options, auth.user);
    // A professional views only their own calendar — default the filter to themselves so the grid
    // reflects their own slot granularity instead of the generic mixed ("Todos") view.
    if (auth.user?.role === 'Professional' && professionals.value.length === 1) {
      selectProfessional(professionals.value[0].id);
    }
  }
  if (resResult.ok) {
    resources.value = resResult.data.map((r) => ({
      id: Number(r.id),
      label: r.name,
    }));
  }
});

function selectProfessional(id: number | null) {
  selectedProfessional.value = id;
  emitFilters();
}

function selectResource(id: number | null) {
  selectedResource.value = id;
  emitFilters();
}

function emitFilters() {
  emit('update:filters', {
    professional_user_id: selectedProfessional.value,
    resource_id: selectedResource.value,
  });
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-sm font-semibold text-neutral">{{ t('calendar.filterBy') }}:</span>

    <!-- "Todos" only makes sense when there is more than one professional to aggregate. -->
    <button
      v-if="professionals.length > 1"
      type="button"
      class="rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedProfessional === null
        ? 'bg-accent text-inverted border-accent'
        : 'bg-surface border-border text-current hover:bg-neutral-tint'"
      @click="selectProfessional(null)"
    >
      {{ t('calendar.allProfessionals') }}
    </button>

    <button
      v-for="prof in professionals"
      :key="prof.id"
      type="button"
      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedProfessional === prof.id
        ? 'bg-accent text-inverted border-accent'
        : 'bg-surface border-border text-current hover:bg-neutral-tint'"
      @click="selectProfessional(prof.id)"
    >
      <!-- Same hue the professional's blocks use on the calendar. -->
      <span
        class="h-2.5 w-2.5 rounded-full shrink-0"
        :style="{ backgroundColor: colorForProfessional(prof.id).bg }"
        aria-hidden="true"
      />
      {{ prof.label }}
    </button>

    <span v-if="resources.length > 0" class="h-5 w-px bg-border mx-1" aria-hidden="true" />

    <button
      v-if="resources.length > 0"
      type="button"
      class="rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedResource === null
        ? 'bg-accent text-inverted border-accent'
        : 'bg-surface border-border text-current hover:bg-neutral-tint'"
      @click="selectResource(null)"
    >
      {{ t('calendar.allResources') }}
    </button>

    <button
      v-for="res in resources"
      :key="res.id"
      type="button"
      class="rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedResource === res.id
        ? 'bg-accent text-inverted border-accent'
        : 'bg-surface border-border text-current hover:bg-neutral-tint'"
      @click="selectResource(res.id)"
    >
      {{ res.label }}
    </button>
  </div>
</template>
