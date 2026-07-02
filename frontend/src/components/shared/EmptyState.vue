<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  heading?: string;
  body?: string;
  icon?: object;
}>(), {});
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 text-center text-neutral">
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
