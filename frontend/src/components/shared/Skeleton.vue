<script setup lang="ts">
import { i18n } from '@/i18n';

// Uses the global i18n instance (not useI18n()) — mounted by many consumers, not all of which
// register the i18n plugin in their tests.

withDefaults(defineProps<{
  variant?: 'row' | 'tile' | 'grid';
  rows?: number;
}>(), {
  variant: 'row',
  rows: 3,
});
</script>

<template>
  <div
    v-if="variant === 'row'"
    class="space-y-3"
    role="status"
    aria-busy="true"
    :aria-label="i18n.global.t('loading')"
  >
    <div
      v-for="i in rows"
      :key="i"
      class="h-10 animate-pulse rounded-md bg-border"
    />
  </div>

  <div
    v-else-if="variant === 'tile'"
    class="grid grid-cols-2 gap-4 sm:grid-cols-3"
    role="status"
    aria-busy="true"
    :aria-label="i18n.global.t('loading')"
  >
    <div
      v-for="i in rows"
      :key="i"
      class="h-24 animate-pulse rounded-lg bg-border"
    />
  </div>

  <div
    v-else
    class="grid grid-cols-7 gap-1"
    role="status"
    aria-busy="true"
    :aria-label="i18n.global.t('loading')"
  >
    <div
      v-for="i in rows * 7"
      :key="i"
      class="h-16 animate-pulse rounded bg-border"
    />
  </div>
</template>
