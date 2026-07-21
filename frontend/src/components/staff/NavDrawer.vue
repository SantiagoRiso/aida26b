<script setup lang="ts">
import { watch } from 'vue';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import StaffNavPanel from '@/components/staff/StaffNavPanel.vue';

// Headless UI's Dialog is what gives this the modal behaviour a drawer needs: focus moves into the
// panel on open and back to the trigger on close, focus stays trapped while open, Escape and an
// outside tap dismiss, and the rest of the shell is hidden from assistive tech. Driven by the
// Dialog's own `open` prop rather than the TransitionRoot wrapper used elsewhere, which renders
// nothing under jsdom and so puts the focus behaviour out of reach of a component test; the slide
// is a plain enter transition instead.

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const route = useRoute();

// A tapped link navigates underneath the overlay, which would otherwise stay covering the
// destination the user just asked for.
watch(
  () => route.fullPath,
  () => {
    if (props.open) emit('close');
  },
);
</script>

<template>
  <Dialog :open="open" class="relative z-40" @close="emit('close')">
    <div class="fixed inset-0 bg-black/40" aria-hidden="true" />

    <div class="fixed inset-y-0 left-0 flex max-w-[85vw]">
      <Transition
        appear
        enter-active-class="transform transition ease-out duration-200"
        enter-from-class="-translate-x-full"
        enter-to-class="translate-x-0"
      >
        <DialogPanel class="flex w-64 flex-col border-r border-border bg-card shadow-xl">
          <div class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <DialogTitle class="text-sm font-semibold text-current">{{ t('nav.menu') }}</DialogTitle>
            <button
              type="button"
              class="rounded-md p-1 text-neutral hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              :aria-label="t('actions.close')"
              @click="emit('close')"
            >
              <XMarkIcon class="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <StaffNavPanel />
        </DialogPanel>
      </Transition>
    </div>
  </Dialog>
</template>
