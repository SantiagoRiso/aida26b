<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import MaterialIcon from '@/components/shared/MaterialIcon.vue';
import SidebarNav from '@/components/staff/SidebarNav.vue';
import { useStateLabel } from '@/composables/useStateLabel';

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
  <!-- Fixed to the viewport height so the sidebar stays put and only <main> scrolls when a view
       is taller than the screen (otherwise the whole page scrolls and the sidebar leaves with it). -->
  <div class="flex h-screen bg-surface">
    <aside class="flex w-56 flex-col border-r border-border bg-card">
      <div class="flex h-14 items-center px-4 border-b border-border">
        <span class="text-sm font-semibold text-current truncate">Agenda</span>
      </div>
      <SidebarNav class="flex-1 overflow-y-auto" />

      <div class="border-t border-border p-4">
        <div class="mb-2 truncate text-sm text-neutral">
          {{ auth.user?.username }}
          <span v-if="auth.user" class="ml-1 text-xs">({{ roleLabel(auth.user.role) }})</span>
        </div>
        <button
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface"
          @click="logout"
        >
          <MaterialIcon name="logout" class="h-4 w-4" />
          {{ t('nav.logout') }}
        </button>
      </div>
    </aside>

    <main class="flex-1 overflow-y-auto p-6">
      <RouterView />
    </main>
  </div>
</template>
