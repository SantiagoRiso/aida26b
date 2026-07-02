<script setup lang="ts">
const props = withDefaults(defineProps<{
  variant?: 'row' | 'tile' | 'grid';
  rows?: number;
}>(), {
  variant: 'row',
  rows: 3,
});
</script>

<template>
  <div v-if="variant === 'row'" class="space-y-3" aria-busy="true" aria-label="Loading…">
    <div
      v-for="i in rows"
      :key="i"
      class="h-10 animate-pulse rounded-md bg-border"
    />
  </div>

  <div v-else-if="variant === 'tile'" class="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-busy="true" aria-label="Loading…">
    <div
      v-for="i in rows"
      :key="i"
      class="h-24 animate-pulse rounded-lg bg-border"
    />
  </div>

  <div v-else class="grid grid-cols-7 gap-1" aria-busy="true" aria-label="Loading…">
    <div
      v-for="i in rows * 7"
      :key="i"
      class="h-16 animate-pulse rounded bg-border"
    />
  </div>
</template>
