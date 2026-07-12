<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ title: string; defaultOpen?: boolean }>();
const open = ref(props.defaultOpen ?? false);
</script>

<template>
  <section class="rounded-lg border border-border bg-card">
    <button
      type="button"
      class="flex w-full items-center justify-between px-5 py-4 text-left"
      :aria-expanded="open"
      @click="open = !open"
    >
      <h2 class="text-lg font-semibold text-heading">{{ title }}</h2>
      <svg
        class="h-5 w-5 text-neutral transition-transform"
        :class="open ? 'rotate-180' : ''"
        fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    <div v-show="open" class="border-t border-border px-5 py-5">
      <slot />
    </div>
  </section>
</template>
