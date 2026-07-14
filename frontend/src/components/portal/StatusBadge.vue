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
      return 'bg-blue-100 text-blue-700';
    case 'scheduled':
      return 'bg-accent/10 text-accent';
    case 'completed':
      return 'bg-green-100 text-success';
    case 'canceled':
    case 'no_show':
    case 'rejected':
      return 'bg-slate-100 text-neutral';
    default:
      return 'bg-slate-100 text-neutral';
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
