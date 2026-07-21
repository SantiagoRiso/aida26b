<script setup lang="ts">
import { computed } from 'vue';
import { useStateLabel } from '@/composables/useStateLabel';

const props = defineProps<{
  state: string;
}>();

const { stateLabel } = useStateLabel();

const badgeClass = computed(() => {
  switch (props.state) {
    case 'requested':
      return 'bg-info-tint text-info-strong';
    case 'scheduled':
      return 'bg-accent-tint text-accent-strong';
    case 'completed':
      return 'bg-success-tint text-success-strong';
    case 'canceled':
    case 'no_show':
    case 'rejected':
      return 'bg-neutral-tint text-body';
    default:
      return 'bg-neutral-tint text-body';
  }
});
</script>

<template>
  <span
    :class="['inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', badgeClass]"
  >
    {{ stateLabel(state) }}
  </span>
</template>
