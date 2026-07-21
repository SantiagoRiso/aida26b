<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import MaterialIcon from '@/components/shared/MaterialIcon.vue';
import SidebarNav from '@/components/staff/SidebarNav.vue';
import { useStateLabel } from '@/composables/useStateLabel';

// Nav links plus the signed-in identity and logout, shared by the desktop sidebar and the mobile
// drawer so both shells offer the same set of destinations and the same way out.

const { t } = useI18n();
const { roleLabel } = useStateLabel();
const auth = useAuthStore();
const router = useRouter();

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <SidebarNav class="min-h-0 flex-1 overflow-y-auto" />

    <div class="border-t border-border p-4">
      <div class="mb-2 truncate text-sm text-neutral">
        {{ auth.user?.username }}
        <span v-if="auth.user" class="ml-1 text-xs">({{ roleLabel(auth.user.role) }})</span>
      </div>
      <button
        type="button"
        class="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold hover:bg-surface"
        @click="logout"
      >
        <MaterialIcon name="logout" class="h-4 w-4" />
        {{ t('nav.logout') }}
      </button>
    </div>
  </div>
</template>
