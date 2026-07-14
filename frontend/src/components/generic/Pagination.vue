<script setup lang="ts">
import { computed } from 'vue';
import { i18n } from '@/i18n';

// Uses the global i18n instance (not useI18n()) — mounted by many consumers, not all of
// which register the i18n plugin in their tests.

const props = defineProps<{
  page: number;
  limit: number;
  total: number;
}>();

const emit = defineEmits<{ change: [page: number] }>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)));
</script>

<template>
  <div class="flex items-center justify-between py-3 text-sm text-neutral">
    <span>
      {{ i18n.global.t('generic.page') }} {{ page }}
      {{ i18n.global.t('generic.of') }} {{ totalPages }}
      · {{ i18n.global.t('generic.total') }}: {{ total }}
    </span>
    <div class="flex gap-2">
      <button
        type="button"
        :disabled="page <= 1"
        class="rounded border border-border px-3 py-1 disabled:opacity-40 hover:bg-surface"
        @click="emit('change', page - 1)"
      >
        {{ i18n.global.t('generic.previous') }}
      </button>
      <button
        type="button"
        :disabled="page >= totalPages"
        class="rounded border border-border px-3 py-1 disabled:opacity-40 hover:bg-surface"
        @click="emit('change', page + 1)"
      >
        {{ i18n.global.t('generic.next') }}
      </button>
    </div>
  </div>
</template>
