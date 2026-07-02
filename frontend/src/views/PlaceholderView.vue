<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';

const route = useRoute();
const { t } = useI18n();
</script>

<template>
  <!-- Shared placeholder: swap the route record's component import to replace it, not this file. -->
  <div class="flex min-h-screen flex-col items-center justify-center bg-surface text-neutral">
    <p class="text-lg font-semibold">{{ route.name ? String(route.name) : 'Esta pantalla' }}</p>
    <p class="mt-2 text-sm">Esta sección está en construcción.</p>
  </div>
</template>
