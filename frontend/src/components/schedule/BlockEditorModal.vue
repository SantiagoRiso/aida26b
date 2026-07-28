<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogPanel, DialogTitle, TransitionRoot, TransitionChild } from '@headlessui/vue';
import AppButton from '@/components/shared/AppButton.vue';
import TimeField from '@/components/shared/TimeField.vue';
import BlockServicesPanel from '@/components/schedule/BlockServicesPanel.vue';
import type { TemplateBlock } from '@/composables/scheduleTemplateGrid';
import { toMinutes, isValidTimeRange } from '@shared/ssot/domain';
import type { Weekday } from '@shared/ssot/domain';
import FieldError from '@/components/shared/FieldError.vue';
import { structure } from '@shared/ssot/structure';
import { useLabel } from '@/composables/useLabel';

const props = withDefaults(defineProps<{
  open: boolean;
  // Null while creating: the same dialog adds a block and edits one, so both reach the weekday and
  // the times by keyboard.
  block: TemplateBlock | null;
  // Validates + persists the block; resolves true on success. The modal orchestrates the full
  // submit (block then services) so Guardar commits everything and Cancelar discards.
  submit: (times: { weekday: Weekday; startTime: string; endTime: string }) => Promise<boolean>;
  // Resource-owned blocks have no services to attach; default true (professional blocks).
  showServices?: boolean;
}>(), { showServices: true });
const emit = defineEmits<{
  delete: [];
  close: [];
}>();

const { t } = useI18n();
const { label } = useLabel();
const servicesRef = ref<InstanceType<typeof BlockServicesPanel> | null>(null);
const submitting = ref(false);

const weekdayColumn = structure.tables.schedule_blocks.columns.weekday;
const weekdayOptions = computed(() =>
  weekdayColumn.options.map((option) => ({ value: option.value, label: label(option.label) })));

// The same rule the schedule_blocks_time_order CHECK enforces. Without it a block whose end is not
// after its start reached the database and came back as a constraint error, which named no field.
const rangeError = ref('');
const rangeValid = computed(() => isValidTimeRange(startTime.value, endTime.value));

async function onSubmit() {
  if (submitting.value) return;
  if (!rangeValid.value) {
    rangeError.value = t('apiError.endAfterStart');
    return;
  }
  rangeError.value = '';
  submitting.value = true;
  try {
    // The block first (it can reject on overlap), then the pending service changes; close only when
    // both commit. A failure leaves the modal open so the user can fix and retry.
    const okBlock = await props.submit({
      weekday: weekday.value,
      startTime: startTime.value,
      endTime: endTime.value,
    });
    if (!okBlock) return;
    const okServices = servicesRef.value ? await servicesRef.value.save() : true;
    if (okServices) emit('close');
  } finally {
    submitting.value = false;
  }
}

// A new block opens on the first working day of a typical week rather than empty, so the dialog is
// one confirm away from a usable block.
const CREATE_DEFAULTS = { weekday: 'mon' as Weekday, start_time: '09:00', end_time: '13:00' };

// Local, unsaved edits. Reset whenever the modal (re)opens or a different block is selected, so a
// stale edit never leaks across blocks.
const weekday = ref<Weekday>(CREATE_DEFAULTS.weekday);
const startTime = ref('');
const endTime = ref('');
watch(
  () => [props.open, props.block?.id] as const,
  () => {
    if (!props.open) return;
    const source = props.block ?? CREATE_DEFAULTS;
    weekday.value = source.weekday;
    startTime.value = source.start_time;
    endTime.value = source.end_time;
    rangeError.value = '';
  },
  { immediate: true },
);

// Live length feeds the services panel's slot-fit warning as the times are edited.
const liveMinutes = computed(() => {
  const mins = toMinutes(endTime.value) - toMinutes(startTime.value);
  return Number.isFinite(mins) && mins > 0 ? mins : 0;
});
</script>

<template>
  <TransitionRoot :show="open" as="template">
    <Dialog class="relative z-40" @close="emit('close')">
      <TransitionChild
        as="template"
        enter="ease-out duration-200" enter-from="opacity-0" enter-to="opacity-100"
        leave="ease-in duration-150" leave-from="opacity-100" leave-to="opacity-0"
      >
        <div class="fixed inset-0 bg-black/30" aria-hidden="true" />
      </TransitionChild>

      <div class="fixed inset-0 flex items-center justify-center p-4">
        <TransitionChild
          as="template"
          enter="ease-out duration-200" enter-from="opacity-0 scale-95" enter-to="opacity-100 scale-100"
          leave="ease-in duration-150" leave-from="opacity-100 scale-100" leave-to="opacity-0 scale-95"
        >
          <DialogPanel class="w-full max-w-md rounded-xl bg-card p-6 shadow-xl" data-testid="block-editor-modal">
            <DialogTitle class="text-lg font-semibold">
              {{ block ? t('schedule.editBlock') : t('schedule.newBlock') }}
            </DialogTitle>

            <div class="mt-4 flex flex-wrap gap-4">
              <label class="flex flex-col gap-1 text-sm">
                {{ label(weekdayColumn.label) }}
                <select
                  v-model="weekday"
                  data-testid="block-edit-weekday"
                  class="min-h-[44px] rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option v-for="option in weekdayOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-sm">
                {{ t('schedule.startLabel') }} <span class="text-destructive">*</span>
                <TimeField v-model="startTime" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                {{ t('schedule.endLabel') }} <span class="text-destructive">*</span>
                <TimeField v-model="endTime" />
              </label>
            </div>
            <FieldError :message="rangeError" class="mt-2" data-testid="block-edit-range-error" />

            <BlockServicesPanel
              v-if="block && showServices"
              ref="servicesRef"
              :block="block"
              :block-minutes="liveMinutes"
              class="mt-5 border-t border-border pt-4"
            />

            <div class="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
              <AppButton v-if="block" variant="destructive" data-testid="block-edit-delete" @click="emit('delete')">
                {{ t('schedule.deleteBlock') }}
              </AppButton>
              <span v-else />
              <div class="flex gap-3">
                <button
                  type="button"
                  class="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
                  @click="emit('close')"
                >
                  {{ t('actions.cancel') }}
                </button>
                <AppButton
                  data-testid="block-edit-save"
                  :loading="submitting"
                  @click="onSubmit"
                >
                  {{ t('schedule.saveBlock') }}
                </AppButton>
              </div>
            </div>
          </DialogPanel>
        </TransitionChild>
      </div>
    </Dialog>
  </TransitionRoot>
</template>
