<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { listRows } from '@/api/crud';

const { t } = useI18n();

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
    listRows<{ id: number; display_name: string }>('professionals', { limit: 200 }),
    listRows<{ id: number; name: string }>('resources', { limit: 200 }),
  ]);
  if (profResult.ok) {
    professionals.value = (profResult.data as { id: number; display_name: string }[]).map((p) => ({
      id: p.id,
      label: p.display_name,
    }));
  }
  if (resResult.ok) {
    resources.value = (resResult.data as { id: number; name: string }[]).map((r) => ({
      id: r.id,
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

    <button
      type="button"
      class="rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedProfessional === null
        ? 'bg-accent text-white border-accent'
        : 'bg-surface border-border text-current hover:bg-slate-100'"
      @click="selectProfessional(null)"
    >
      {{ t('calendar.allProfessionals') }}
    </button>

    <button
      v-for="prof in professionals"
      :key="prof.id"
      type="button"
      class="rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedProfessional === prof.id
        ? 'bg-accent text-white border-accent'
        : 'bg-surface border-border text-current hover:bg-slate-100'"
      @click="selectProfessional(prof.id)"
    >
      {{ prof.label }}
    </button>

    <span v-if="resources.length > 0" class="h-5 w-px bg-border mx-1" aria-hidden="true" />

    <button
      v-if="resources.length > 0"
      type="button"
      class="rounded-full px-3 py-1 text-sm font-semibold border transition-colors"
      :class="selectedResource === null
        ? 'bg-accent text-white border-accent'
        : 'bg-surface border-border text-current hover:bg-slate-100'"
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
        ? 'bg-accent text-white border-accent'
        : 'bg-surface border-border text-current hover:bg-slate-100'"
      @click="selectResource(res.id)"
    >
      {{ res.label }}
    </button>
  </div>
</template>
