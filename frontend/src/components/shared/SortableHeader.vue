<script setup lang="ts">
// The sort control for the bespoke tables, matching what GenericTable renders for descriptor-driven
// ones: a real button inside the header cell, and aria-sort on the cell itself, so the current
// order is announced rather than only drawn.

defineProps<{
  field: string;
  label: string;
  active: string;
  dir: 'asc' | 'desc';
}>();

const emit = defineEmits<{ sort: [field: string] }>();
</script>

<template>
  <th
    scope="col"
    class="text-left font-semibold"
    :aria-sort="active === field ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'"
  >
    <button
      type="button"
      class="flex w-full select-none items-center whitespace-nowrap px-4 py-3 text-left font-semibold hover:bg-border focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      @click="emit('sort', field)"
    >
      {{ label }}
      <span v-if="active === field" class="ml-1 text-xs text-neutral" aria-hidden="true">
        {{ dir === 'asc' ? '↑' : '↓' }}
      </span>
    </button>
  </th>
</template>
