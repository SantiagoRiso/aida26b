<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, DialogPanel, DialogTitle, TransitionRoot, TransitionChild } from '@headlessui/vue';
import AppButton from '@/components/shared/AppButton.vue';
import BlockServicesPanel from '@/components/schedule/BlockServicesPanel.vue';
import type { TemplateBlock } from '@/composables/scheduleTemplateGrid';

const props = defineProps<{
  open: boolean;
  block: TemplateBlock | null;
  // Validates + persists the block window; resolves true on success. The modal orchestrates the
  // full submit (times then services) so Guardar commits everything and Cancelar discards.
  submitTimes: (times: { startTime: string; endTime: string }) => Promise<boolean>;
}>();
const emit = defineEmits<{
  delete: [];
  close: [];
}>();

const { t } = useI18n();
const servicesRef = ref<InstanceType<typeof BlockServicesPanel> | null>(null);
const submitting = ref(false);

async function onSubmit() {
  if (submitting.value || !props.block) return;
  submitting.value = true;
  try {
    // Times first (they can reject on overlap), then the pending service changes; close only when
    // both commit. A failure leaves the modal open so the user can fix and retry.
    const okTimes = await props.submitTimes({ startTime: startTime.value, endTime: endTime.value });
    if (!okTimes) return;
    const okServices = servicesRef.value ? await servicesRef.value.save() : true;
    if (okServices) emit('close');
  } finally {
    submitting.value = false;
  }
}

// Local, unsaved edits of the block window. Reset from the block whenever the modal (re)opens or a
// different block is selected, so a stale edit never leaks across blocks.
const startTime = ref('');
const endTime = ref('');
watch(
  () => [props.open, props.block?.id] as const,
  () => {
    if (props.open && props.block) {
      startTime.value = props.block.start_time;
      endTime.value = props.block.end_time;
    }
  },
  { immediate: true },
);

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
}

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
            <DialogTitle class="text-lg font-semibold">{{ t('schedule.editBlock') }}</DialogTitle>

            <div v-if="block" class="mt-4 flex flex-wrap gap-4">
              <label class="flex flex-col gap-1 text-sm">
                {{ t('schedule.startLabel') }}
                <input type="time" step="60" v-model="startTime" data-testid="block-edit-start"
                       class="min-h-[44px] rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </label>
              <label class="flex flex-col gap-1 text-sm">
                {{ t('schedule.endLabel') }}
                <input type="time" step="60" v-model="endTime" data-testid="block-edit-end"
                       class="min-h-[44px] rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              </label>
            </div>

            <BlockServicesPanel
              v-if="block"
              ref="servicesRef"
              :key="block.id"
              :block="block"
              :block-minutes="liveMinutes"
              class="mt-5 border-t border-border pt-4"
            />

            <div class="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
              <AppButton variant="destructive" data-testid="block-edit-delete" @click="emit('delete')">
                {{ t('schedule.deleteBlock') }}
              </AppButton>
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
