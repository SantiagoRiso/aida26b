<script setup lang="ts">
// Scope chooser for a series-bound appointment: this occurrence only, this-and-future, or the whole
// series. ConfirmDialog-style headlessui dialog with three actions instead of one. Shared by cancel,
// reschedule, and the rule editor — `action` swaps the title/body copy and, for a rule edit (there is
// no "this occurrence only" recurrence), hides the 'this' choice.
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  TransitionRoot,
  TransitionChild,
} from '@headlessui/vue';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AppButton from '@/components/shared/AppButton.vue';

export type SeriesScope = 'this' | 'future' | 'whole';
export type SeriesScopeAction = 'cancel' | 'reschedule' | 'edit-rule';

const props = withDefaults(
  defineProps<{
    open: boolean;
    action?: SeriesScopeAction;
  }>(),
  { action: 'cancel' },
);

const emit = defineEmits<{
  select: [scope: SeriesScope];
  cancel: [];
}>();

const { t } = useI18n();

const TITLE_KEYS: Record<SeriesScopeAction, string> = {
  cancel: 'calendar.scopeDialogTitle',
  reschedule: 'calendar.scopeDialogTitleReschedule',
  'edit-rule': 'calendar.scopeDialogTitleEditRule',
};
const BODY_KEYS: Record<SeriesScopeAction, string> = {
  cancel: 'calendar.scopeDialogBody',
  reschedule: 'calendar.scopeDialogBodyReschedule',
  'edit-rule': 'calendar.scopeDialogBodyEditRule',
};

const titleText = computed(() => t(TITLE_KEYS[props.action]));
const bodyText = computed(() => t(BODY_KEYS[props.action]));
// A rule edit has no "this occurrence only" — the recurrence pattern itself is what's changing.
const showsThis = computed(() => props.action !== 'edit-rule');
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
            <DialogTitle class="text-lg font-semibold">{{ titleText }}</DialogTitle>
            <p class="mt-2 text-sm text-neutral">{{ bodyText }}</p>

            <div class="mt-6 flex flex-col gap-2">
              <AppButton v-if="showsThis" variant="neutral" @click="emit('select', 'this')">
                {{ t('calendar.scopeThis') }}
              </AppButton>
              <AppButton variant="neutral" @click="emit('select', 'future')">
                {{ t('calendar.scopeFuture') }}
              </AppButton>
              <AppButton variant="destructive" @click="emit('select', 'whole')">
                {{ t('calendar.scopeWhole') }}
              </AppButton>
            </div>

            <div class="mt-4 flex justify-end">
              <AppButton variant="neutral" @click="emit('cancel')">
                {{ t('actions.cancel') }}
              </AppButton>
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
