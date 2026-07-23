<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

withDefaults(defineProps<{
  heading?: string;
  body?: string;
  icon?: object;
}>(), {});
</script>

<template>
  <!-- role="status" so a list that goes from results to empty announces the change instead of
       falling silent for a screen-reader user. -->
  <div
    class="flex flex-col items-center justify-center py-12 text-center text-neutral"
    role="status"
  >
    <component
      :is="icon"
      v-if="icon"
      class="mb-4 h-12 w-12 text-neutral"
      aria-hidden="true"
    />
    <h3 class="text-lg font-semibold text-neutral">
      {{ heading ?? t('emptyState.noAppointmentsHeading') }}
    </h3>
    <p class="mt-2 max-w-sm text-sm">
      {{ body ?? t('emptyState.noAppointmentsBody') }}
    </p>
  </div>
</template>
