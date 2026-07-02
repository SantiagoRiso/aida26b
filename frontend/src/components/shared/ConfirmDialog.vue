<script setup lang="ts">
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue';

const props = defineProps<{
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog class="relative z-50" @close="emit('cancel')">
      <TransitionChild
        as="template"
        enter="ease-out duration-200"
        enter-from="opacity-0"
        enter-to="opacity-100"
        leave="ease-in duration-150"
        leave-from="opacity-100"
        leave-to="opacity-0"
      >
        <div class="fixed inset-0 bg-black/30" aria-hidden="true" />
      </TransitionChild>

      <div class="fixed inset-0 flex items-center justify-center p-4">
        <TransitionChild
          as="template"
          enter="ease-out duration-200"
          enter-from="opacity-0 scale-95"
          enter-to="opacity-100 scale-100"
          leave="ease-in duration-150"
          leave-from="opacity-100 scale-100"
          leave-to="opacity-0 scale-95"
        >
          <DialogPanel class="w-full max-w-sm rounded-xl bg-card p-6 shadow-xl">
            <DialogTitle class="text-lg font-semibold">{{ title }}</DialogTitle>
            <p class="mt-2 text-sm text-neutral">{{ body }}</p>

            <div class="mt-6 flex justify-end gap-3">
              <button
                type="button"
                class="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
                @click="emit('cancel')"
              >
                Cancelar
              </button>
              <button
                type="button"
                :class="[
                  'min-h-[44px] rounded-md px-4 py-2 text-sm font-semibold text-white',
                  destructive ? 'bg-destructive hover:bg-destructive-hover' : 'bg-accent hover:bg-accent-hover',
                ]"
                @click="emit('confirm')"
              >
                {{ confirmLabel }}
              </button>
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
