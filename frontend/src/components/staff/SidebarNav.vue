<script setup lang="ts">
import { computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor } from '@/router/access';
import { SCREEN_ROLES } from '@/router/access';

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const userRole = computed(() => auth.user?.role);

const navItems = [
  { name: 'staff-dashboard',     labelKey: 'nav.dashboard',     roles: SCREEN_ROLES['staff-dashboard'] },
  { name: 'staff-calendar',      labelKey: 'nav.calendar',       roles: SCREEN_ROLES['staff-calendar'] },
  { name: 'staff-schedule',      labelKey: 'nav.schedule',       roles: SCREEN_ROLES['staff-schedule'] },
  { name: 'staff-requests',      labelKey: 'nav.requests',       roles: SCREEN_ROLES['staff-requests'] },
  { name: 'staff-clients',       labelKey: 'nav.clients',        roles: SCREEN_ROLES['staff-clients'] },
  { name: 'staff-professionals', labelKey: 'nav.professionals',  roles: SCREEN_ROLES['staff-professionals'] },
  { name: 'staff-business',      labelKey: 'nav.business',       roles: SCREEN_ROLES['staff-business'] },
  { name: 'staff-users',         labelKey: 'nav.users',          roles: SCREEN_ROLES['staff-users'] },
  { name: 'staff-audit',         labelKey: 'nav.audit',          roles: SCREEN_ROLES['staff-audit'] },
  { name: 'staff-profile',       labelKey: 'nav.profile',        roles: SCREEN_ROLES['staff-profile'] },
  { name: 'staff-settings',      labelKey: 'nav.settings',       roles: SCREEN_ROLES['staff-settings'] },
] as const;

const visibleItems = computed(() =>
  navItems.filter((item) =>
    userRole.value ? roleAllowedFor(item.roles, userRole.value) : false,
  ),
);

function isActive(routeName: string): boolean {
  return route.name === routeName;
}
</script>

<template>
  <nav class="flex flex-col gap-1 px-2 py-4">
    <RouterLink
      v-for="item in visibleItems"
      :key="item.name"
      :to="{ name: item.name }"
      class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold whitespace-nowrap transition-colors"
      :class="
        isActive(item.name)
          ? 'bg-accent text-white'
          : 'text-neutral hover:bg-surface hover:text-current'
      "
    >
      {{ t(item.labelKey) }}
    </RouterLink>
  </nav>
</template>
