<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUiStore } from '@/stores/ui';
import type { Toast } from '@/stores/ui';

const ui = useUiStore();
const { t } = useI18n();

const AUTO_DISMISS_MS = 5000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleAutoDismiss(toast: Toast) {
  if (toast.kind === 'info' || toast.kind === 'success') {
    const timer = setTimeout(() => ui.dismissToast(toast.id), AUTO_DISMISS_MS);
    timers.set(toast.id, timer);
  }
}

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  ui.dismissToast(id);
}

watch(
  () => ui.toasts,
  (toasts) => {
    for (const toast of toasts) {
      if (!timers.has(toast.id) && (toast.kind === 'info' || toast.kind === 'success')) {
        scheduleAutoDismiss(toast);
      }
    }
  },
  { deep: true },
);

onUnmounted(() => {
  timers.forEach((t) => clearTimeout(t));
});

function kindClasses(kind: Toast['kind']): string {
  if (kind === 'error') return 'bg-destructive text-white';
  if (kind === 'success') return 'bg-success text-white';
  return 'bg-info text-white';
}
</script>

<template>
  <div
    class="fixed right-4 top-4 z-50 flex flex-col gap-2"
    aria-live="polite"
    aria-atomic="false"
  >
    <!-- Vue's built-in TransitionGroup — not imported from @headlessui/vue. -->
    <TransitionGroup
      name="toast"
      tag="div"
      class="flex flex-col gap-2"
    >
      <div
        v-for="toast in ui.toasts"
        :key="toast.id"
        :class="['flex items-center justify-between rounded-md px-4 py-3 text-sm font-semibold shadow-lg min-w-[280px] max-w-sm', kindClasses(toast.kind)]"
        role="alert"
      >
        <span>{{ t(`toast.${toast.messageKey}`, toast.messageKey) }}</span>
        <button
          type="button"
          class="ml-4 flex-shrink-0 rounded opacity-70 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          :aria-label="t('toast.close')"
          @click="dismiss(toast.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
