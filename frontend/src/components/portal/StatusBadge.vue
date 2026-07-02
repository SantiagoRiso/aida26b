<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  state: string;
}>();

const { t } = useI18n();

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

const labelKey = computed(() => {
  const keys: Record<string, string> = {
    requested: 'status.requested',
    scheduled: 'status.scheduled',
    completed: 'status.completed',
    canceled: 'status.canceled',
    no_show: 'status.no_show',
    rejected: 'status.rejected',
  };
  return keys[props.state] ?? 'status.requested';
});
</script>

<template>
  <span
    :class="['inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', badgeClass]"
  >
    {{ t(labelKey) }}
  </span>
</template>
