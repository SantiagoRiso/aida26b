<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import PortalNav from '@/components/portal/PortalNav.vue';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();

async function logout() {
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <!-- Distinct top-nav shell for the client portal — no sidebar, no staff screens. -->
  <div class="flex min-h-screen flex-col bg-surface">
    <header class="border-b border-border bg-card">
      <div class="mx-auto flex max-w-4xl items-center justify-between px-4 h-14">
        <span class="text-sm font-semibold text-current">Agenda</span>

        <PortalNav />

        <div class="flex items-center gap-3">
          <span class="text-sm text-neutral hidden sm:block">{{ auth.user?.username }}</span>
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface min-h-[36px]"
            @click="logout"
          >
            {{ t('nav.logout') }}
          </button>
        </div>
      </div>
    </header>

    <main class="flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl px-4 py-6">
        <RouterView />
      </div>
    </main>
  </div>
</template>
