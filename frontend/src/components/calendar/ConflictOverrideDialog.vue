<script setup lang="ts">
// Sobreturno warn-then-confirm dialog. Shows the specific conflicts, then lets
// staff confirm with override:true or cancel (which calls revert() to snap the block back).

import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { useConflictVerdict } from '@/composables/useConflictVerdict';
import AppButton from '@/components/shared/AppButton.vue';

const props = defineProps<{
  open: boolean;
  verdict: ConflictVerdict | null;
  // FullCalendar revert callback for drag/resize snap-back on cancel.
  revert?: (() => void) | null;
}>();

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const { t } = useI18n();
const { describe } = useConflictVerdict();

const description = computed(() =>
  props.verdict ? describe(props.verdict) : { lines: [], canOverride: false },
);

function handleConfirm() {
  emit('confirm');
}

function handleCancel() {
  props.revert?.();
  emit('cancel');
}
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog class="relative z-50" @close="handleCancel">
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
          <DialogPanel class="w-full max-w-md rounded-xl bg-card shadow-xl overflow-hidden">
            <div class="bg-warning/10 border-b border-warning/30 px-6 py-4">
              <DialogTitle class="text-base font-semibold text-warning-700">
                {{ t('calendar.conflictTitle') }}
              </DialogTitle>
            </div>

            <div class="px-6 py-4 flex flex-col gap-3">
              <p class="text-sm">{{ t('calendar.conflictBody') }}</p>

              <ul v-if="description.lines.length > 0" class="flex flex-col gap-1 list-disc list-inside">
                <li
                  v-for="(line, i) in description.lines"
                  :key="i"
                  class="text-sm"
                >
                  {{ line }}
                </li>
              </ul>

              <p v-if="!description.canOverride" class="text-sm text-neutral italic">
                {{ t('conflicts.cannotOverride') }}
              </p>
            </div>

            <div class="px-6 pb-5 flex justify-end gap-3">
              <AppButton variant="neutral" @click="handleCancel">
                {{ t('actions.cancel') }}
              </AppButton>
              <AppButton v-if="description.canOverride" variant="primary" @click="handleConfirm">
                {{ t('actions.bookAnyway') }}
              </AppButton>
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
