<script setup lang="ts">
import { computed } from 'vue';
import { useLabel } from '@/composables/useLabel';

const props = defineProps<{
  page: number;
  limit: number;
  total: number;
}>();

const emit = defineEmits<{ change: [page: number] }>();

const { label } = useLabel();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)));
</script>

<template>
  <div class="flex items-center justify-between py-3 text-sm text-neutral">
    <span>
      {{ label({ es: 'Página', en: 'Page' }) }} {{ page }}
      {{ label({ es: 'de', en: 'of' }) }} {{ totalPages }}
      · {{ label({ es: 'Total', en: 'Total' }) }}: {{ total }}
    </span>
    <div class="flex gap-2">
      <button
        type="button"
        :disabled="page <= 1"
        class="rounded border border-border px-3 py-1 disabled:opacity-40 hover:bg-surface"
        @click="emit('change', page - 1)"
      >
        {{ label({ es: 'Anterior', en: 'Previous' }) }}
      </button>
      <button
        type="button"
        :disabled="page >= totalPages"
        class="rounded border border-border px-3 py-1 disabled:opacity-40 hover:bg-surface"
        @click="emit('change', page + 1)"
      >
        {{ label({ es: 'Siguiente', en: 'Next' }) }}
      </button>
    </div>
  </div>
</template>
