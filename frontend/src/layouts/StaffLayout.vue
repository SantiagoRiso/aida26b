<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Bars3Icon } from '@heroicons/vue/24/outline';
import StaffNavPanel from '@/components/staff/StaffNavPanel.vue';
import NavDrawer from '@/components/staff/NavDrawer.vue';

const { t } = useI18n();

const drawerOpen = ref(false);

// The drawer and the permanent sidebar are the same navigation at two widths. Once the sidebar is
// back on screen the drawer would be an invisible overlay still holding focus, so widening closes it.
const wideEnoughForSidebar = window.matchMedia?.('(min-width: 768px)');
function closeDrawerOnWiden(event: MediaQueryListEvent) {
  if (event.matches) drawerOpen.value = false;
}
onMounted(() => wideEnoughForSidebar?.addEventListener('change', closeDrawerOnWiden));
onBeforeUnmount(() => wideEnoughForSidebar?.removeEventListener('change', closeDrawerOnWiden));
</script>

<template>
  <!-- Fixed to the viewport height so the sidebar stays put and only <main> scrolls when a view
       is taller than the screen (otherwise the whole page scrolls and the sidebar leaves with it). -->
  <div class="flex h-screen bg-surface">
    <aside class="hidden w-56 flex-col border-r border-border bg-card md:flex">
      <div class="flex h-14 items-center px-4 border-b border-border">
        <span class="text-sm font-semibold text-current truncate">Agenda</span>
      </div>
      <StaffNavPanel />
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:hidden">
        <button
          type="button"
          class="-ml-1 rounded-md p-2 text-neutral hover:bg-surface hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          :aria-label="t('nav.openMenu')"
          :aria-expanded="drawerOpen"
          @click="drawerOpen = true"
        >
          <Bars3Icon class="h-5 w-5" aria-hidden="true" />
        </button>
        <span class="text-sm font-semibold text-current truncate">Agenda</span>
      </header>

      <main class="flex-1 overflow-y-auto p-4 md:p-6">
        <RouterView />
      </main>
    </div>

    <NavDrawer :open="drawerOpen" @close="drawerOpen = false" />
  </div>
</template>
