<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const navItems = [
  { name: 'portal-appointments', labelKey: 'nav.myAppointments' },
  { name: 'portal-request', labelKey: 'nav.requestAppointment' },
  { name: 'portal-balance', labelKey: 'nav.myBalance' },
  { name: 'portal-preferences', labelKey: 'nav.preferences' },
] as const;
</script>

<template>
  <nav class="flex items-center gap-1" aria-label="Portal navigation">
    <RouterLink
      v-for="item in navItems"
      :key="item.name"
      :to="{ name: item.name }"
      class="rounded-md px-3 py-1.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      active-class="bg-accent text-white"
      inactive-class="text-neutral hover:bg-surface"
    >
      {{ t(item.labelKey) }}
    </RouterLink>
  </nav>
</template>
