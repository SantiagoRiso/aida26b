<script setup lang="ts">
import { computed } from 'vue';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';
import { i18n } from '@/i18n';

// Uses the global i18n instance (not useI18n()) — this shared panel is mounted by many
// consumers, not all of which register the i18n plugin in their tests.

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    // 'side' slides in from the right — used on the calendar so the grid stays visible behind the panel.
    variant?: 'modal' | 'side';
    // Caps the panel width in both variants (the side panel still keeps the grid visible behind it).
    size?: 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl' | '7xl';
  }>(),
  { variant: 'modal', size: 'lg' },
);

const emit = defineEmits<{
  close: [];
  // Fires once the close transition finishes — parents clear their content data here so the
  // panel keeps its content through the leave animation instead of blanking mid-close.
  afterLeave: [];
}>();

const modalMaxWidth = computed(
  () =>
    ({
      md: 'max-w-md',
      lg: 'max-w-lg',
      xl: 'max-w-xl',
      '2xl': 'max-w-2xl',
      '3xl': 'max-w-3xl',
      '4xl': 'max-w-4xl',
      '5xl': 'max-w-5xl',
      '6xl': 'max-w-6xl',
      '7xl': 'max-w-7xl',
    })[props.size],
);
</script>

<template>
  <TransitionRoot :show="open" as="template" @after-leave="emit('afterLeave')">
    <Dialog class="relative z-40" @close="emit('close')">
      <TransitionChild
        as="template"
        enter="ease-out duration-200"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-150"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div
          class="fixed inset-0"
          :class="variant === 'side' ? 'bg-black/20' : 'bg-black/30'"
          aria-hidden="true"
        />
      </TransitionChild>

      <!-- w-screen (not w-full) gives the DialogPanel a definite base width so max-w-* actually binds:
           the side parent is shrink-to-fit, where w-full would collapse to the content's natural width. -->
      <div v-if="variant === 'side'" class="fixed inset-y-0 right-0 flex">
        <TransitionChild
          as="template"
          enter="transform transition ease-out duration-200"
          enter-from="translate-x-full opacity-0"
          enter-to="translate-x-0 opacity-100"
          leave="transform transition ease-in duration-150"
          leave-from="translate-x-0 opacity-100"
          leave-to="translate-x-full opacity-0"
        >
          <DialogPanel class="relative flex w-screen flex-col bg-card shadow-xl" :class="modalMaxWidth">
            <div class="flex items-center justify-between border-b border-border px-6 py-4">
              <slot name="header">
                <DialogTitle v-if="title" class="text-lg font-semibold">{{ title }}</DialogTitle>
              </slot>
              <button
                type="button"
                class="rounded-md p-1 text-neutral hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="emit('close')"
                :aria-label="i18n.global.t('actions.close')"
              >
                <XMarkIcon class="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div class="flex-1 overflow-y-auto px-6 py-6">
              <slot />
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>

      <!-- Anchor near the top (not vertically centered): as content height changes — request-flow
           steps, variable slot lists — a centered panel re-centers and visibly jumps. Top-anchoring
           keeps the panel's top fixed; only its bottom grows (capped by max-h + internal scroll). -->
      <div v-else class="fixed inset-0 flex items-start justify-center p-4 sm:pt-[8vh]">
        <TransitionChild
          as="template"
          enter="ease-out duration-200"
          enter-from="opacity-0 scale-95"
          enter-to="opacity-100 scale-100"
          leave="ease-in duration-150"
          leave-from="opacity-100 scale-100"
          leave-to="opacity-0 scale-95"
        >
          <DialogPanel class="relative flex max-h-[85vh] w-full flex-col rounded-xl bg-card shadow-xl" :class="modalMaxWidth">
            <div class="flex items-center justify-between border-b border-border px-6 py-4">
              <slot name="header">
                <DialogTitle v-if="title" class="text-lg font-semibold">{{ title }}</DialogTitle>
              </slot>
              <button
                type="button"
                class="rounded-md p-1 text-neutral hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="emit('close')"
                :aria-label="i18n.global.t('actions.close')"
              >
                <XMarkIcon class="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div class="flex-1 overflow-y-auto px-6 py-6">
              <slot />
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
