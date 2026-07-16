<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue';
import AppButton from '@/components/shared/AppButton.vue';

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

const { t } = useI18n();

// A confirm often opens over a DetailPanel; headlessui would let Escape reach the panel underneath
// and close it instead. Handle Escape ourselves in the capture phase and stop it, so it dismisses
// only this confirm and never the modal behind it.
function onKeydown(e: KeyboardEvent) {
  if (props.open && e.key === 'Escape') {
    e.stopPropagation();
    emit('cancel');
  }
}
onMounted(() => document.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog class="relative z-50" data-confirm-dialog="true" @close="emit('cancel')">
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
              <AppButton variant="neutral" @click="emit('cancel')">
                {{ t('actions.cancel') }}
              </AppButton>
              <AppButton :variant="destructive ? 'destructive' : 'primary'" @click="emit('confirm')">
                {{ confirmLabel }}
              </AppButton>
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
