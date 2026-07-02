<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import SidebarNav from '@/components/staff/SidebarNav.vue';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();

const sidebarOpen = ref(true);

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="flex min-h-screen bg-surface">
    <aside
      class="flex flex-col border-r border-border bg-card transition-all duration-200"
      :class="sidebarOpen ? 'w-56' : 'w-0 overflow-hidden'"
    >
      <div class="flex h-14 items-center justify-between px-4 border-b border-border">
        <span class="text-sm font-semibold text-current truncate">Agenda</span>
      </div>
      <SidebarNav class="flex-1 overflow-y-auto" />
    </aside>

    <div class="flex flex-1 flex-col overflow-hidden">
      <header class="flex h-14 items-center justify-between border-b border-border bg-card px-6">
        <button
          type="button"
          class="rounded-md p-1 text-neutral hover:bg-surface"
          aria-label="Toggle sidebar"
          @click="sidebarOpen = !sidebarOpen"
        >
          <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div class="flex items-center gap-4">
          <span class="text-sm text-neutral">
            {{ auth.user?.username }}
            <span class="ml-1 text-xs">({{ auth.user?.role }})</span>
          </span>
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface"
            @click="logout"
          >
            {{ t('nav.logout') }}
          </button>
        </div>
      </header>

      <main class="flex-1 overflow-y-auto p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
