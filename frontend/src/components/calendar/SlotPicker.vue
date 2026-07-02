<script setup lang="ts">
// Slots come from /api/availability at the block's own granularity (not a fixed grid).

import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getAvailability } from '@/api/scheduling';
import type { TimeInterval } from '@shared/ssot/domain/scheduling';

const props = defineProps<{
  professionalId: number | null;
  date: string | null; // 'YYYY-MM-DD'
  modelValue: string | null; // selected start time 'HH:MM'
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
  // Emits the full slot so the form can derive duration_minutes from end - start.
  slotSelected: [slot: TimeInterval];
}>();

const { t } = useI18n();
const slots = ref<TimeInterval[]>([]);
const loading = ref(false);

watch(
  [() => props.professionalId, () => props.date],
  async ([profId, date]) => {
    slots.value = [];
    if (!profId || !date) return;
    loading.value = true;
    const result = await getAvailability(`prof:${profId}`, date);
    loading.value = false;
    if (result.ok) {
      slots.value = result.data.slots;
    }
  },
  { immediate: true },
);

function select(slot: TimeInterval) {
  emit('update:modelValue', slot.start);
  emit('slotSelected', slot);
}

function slotDuration(slot: TimeInterval): number {
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p class="text-sm font-semibold text-neutral">{{ t('calendar.slotPickerTitle') }}</p>

    <div v-if="loading" class="text-sm text-neutral">{{ t('loading') }}</div>

    <p v-else-if="!professionalId || !date" class="text-sm text-neutral italic">
      Seleccioná un profesional y una fecha para ver los horarios.
    </p>

    <p v-else-if="slots.length === 0" class="text-sm text-neutral italic">
      {{ t('calendar.noSlotsAvailable') }}
    </p>

    <div v-else class="flex flex-wrap gap-2">
      <button
        v-for="slot in slots"
        :key="slot.start"
        type="button"
        class="rounded border px-3 py-1.5 text-sm font-semibold transition-colors min-h-[44px]"
        :class="modelValue === slot.start
          ? 'bg-accent text-white border-accent'
          : 'bg-surface border-border text-current hover:bg-slate-100'"
        :aria-pressed="modelValue === slot.start"
        @click="select(slot)"
      >
        {{ slot.start }}
        <span class="ml-1 text-xs font-normal">({{ slotDuration(slot) }}m)</span>
      </button>
    </div>
  </div>
</template>
