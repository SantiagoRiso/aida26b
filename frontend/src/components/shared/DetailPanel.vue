<script setup lang="ts">
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue';
import { XMarkIcon } from '@heroicons/vue/24/outline';

const props = defineProps<{
  open: boolean;
  title?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog class="relative z-40" @close="emit('close')">
      <!-- Backdrop (semi-transparent so the calendar grid stays visible behind) -->
      <TransitionChild
        as="template"
        enter="ease-out duration-200"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-150"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="fixed inset-0 bg-black/20" aria-hidden="true" />
      </TransitionChild>

      <div class="fixed inset-y-0 right-0 flex">
        <TransitionChild
          as="template"
          enter="transform transition ease-out duration-200"
          enter-from="translate-x-full opacity-0"
          enter-to="translate-x-0 opacity-100"
          leave="transform transition ease-in duration-150"
          leave-from="translate-x-0 opacity-100"
          leave-to="translate-x-full opacity-0"
        >
          <DialogPanel class="relative flex w-full max-w-md flex-col bg-card shadow-xl">
            <div class="flex items-center justify-between border-b border-border px-6 py-4">
              <slot name="header">
                <DialogTitle v-if="title" class="text-lg font-semibold">{{ title }}</DialogTitle>
              </slot>
              <button
                type="button"
                class="rounded-md p-1 text-neutral hover:text-current focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="emit('close')"
                aria-label="Cerrar"
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
