<script setup lang="ts">
// Slots come from /api/availability at the block's own granularity (not a fixed grid).

import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getAvailability } from '@/api/scheduling';
import type { TimeInterval } from '@shared/ssot/domain/scheduling';

const props = defineProps<{
  professionalId: number | null;
  serviceId: number | null; // slots are sized by the chosen service; required to load them
  date: string | null;
  modelValue: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
  // Emits the full slot so the form can derive duration_minutes from end - start.
  slotSelected: [slot: TimeInterval];
}>();

const { t } = useI18n();
const slots = ref<TimeInterval[]>([]);
// Whether the professional works that day at all — an empty slot list on a working day
// means "fully booked", which deserves a different message than "doesn't work that day".
const dayOpen = ref(true);
// A client asking beyond the booking window gets no slots for a distinct reason (not "closed").
const outsideWindow = ref(false);
const loading = ref(false);

// Availability cache keyed by date, scoped to the current professional+service. Pre-warming the
// neighbouring days keeps the date arrows instant: the next/prev day is already fetched, so stepping
// swaps slots in with no loading flicker. A professional/service change invalidates the whole cache.
type DayAvail = { slots: TimeInterval[]; open: boolean; outsideWindow: boolean };
let cache = new Map<string, DayAvail>();
let cacheKey = '';

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const nd = new Date(y, m - 1, d + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())}`;
}

async function fetchDay(profId: number, serviceId: number, date: string): Promise<DayAvail | null> {
  const hit = cache.get(date);
  if (hit) return hit;
  const result = await getAvailability(`prof:${profId}`, date, serviceId);
  if (!result.ok) return null;
  const day: DayAvail = {
    slots: result.data.slots,
    open: result.data.open,
    outsideWindow: result.data.outside_window ?? false,
  };
  cache.set(date, day);
  return day;
}

watch(
  [() => props.professionalId, () => props.serviceId, () => props.date],
  async ([profId, serviceId, date]) => {
    if (!profId || !serviceId || !date) { slots.value = []; dayOpen.value = true; outsideWindow.value = false; return; }

    const key = `${profId}:${serviceId}`;
    if (key !== cacheKey) { cache = new Map(); cacheKey = key; }

    const hit = cache.get(date as string);
    if (hit) {
      // Pre-warmed neighbour — swap in instantly, no loading state (this is what kills the flicker).
      slots.value = hit.slots;
      dayOpen.value = hit.open;
      outsideWindow.value = hit.outsideWindow;
    } else {
      loading.value = true;
      const day = await fetchDay(profId as number, serviceId as number, date as string);
      loading.value = false;
      // The date may have changed while awaiting; ignore a now-stale response.
      if (props.date !== date) return;
      slots.value = day?.slots ?? [];
      dayOpen.value = day?.open ?? true;
      outsideWindow.value = day?.outsideWindow ?? false;
    }

    // Warm both neighbours in the background so the next arrow click has no round-trip.
    void fetchDay(profId as number, serviceId as number, addDaysISO(date as string, 1));
    void fetchDay(profId as number, serviceId as number, addDaysISO(date as string, -1));
  },
  { immediate: true },
);

// Auto-select the slot matching a preset start (e.g. the calendar slot the user clicked) so its
// duration flows to the parent without a second click. Runs whenever either the slots or the preset
// start settle — the two arrive on different ticks when a click opens the form.
watch(
  [slots, () => props.modelValue],
  () => {
    const preset = slots.value.find((s) => s.start === props.modelValue);
    if (preset) emit('slotSelected', preset);
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

    <!-- Reserve at least three rows of slots (3×44px buttons + 2×8px gaps) so the area never collapses
         below that floor — loading, prompt, empty, one row, or a full grid all start at the same
         height, so switching dates doesn't shrink the panel and make it jump. -->
    <div class="min-h-[148px]">
      <div v-if="loading" class="text-sm text-neutral">{{ t('loading') }}</div>

      <p v-else-if="!professionalId || !date" class="text-sm text-neutral italic">
        {{ t('calendar.slotPickerPrompt') }}
      </p>

      <p v-else-if="outsideWindow" class="text-sm text-amber-700 italic">
        {{ t('calendar.outsideBookingWindow') }}
      </p>

      <p v-else-if="slots.length === 0" class="text-sm text-neutral italic">
        {{ t(dayOpen ? 'calendar.dayFullyBooked' : 'calendar.dayNotWorked') }}
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
  </div>
</template>
