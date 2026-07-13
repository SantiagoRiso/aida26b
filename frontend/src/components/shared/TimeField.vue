<script setup lang="ts">
// 24h time field: a masked text input (colon auto-inserted once the hour is unambiguous) plus a
// click-open popover with hour/minute adjusters. Always 24h regardless of browser locale, fully
// click-and-type editable. Binds 'HH:mm' strings — the API contract is unchanged.
import { ref, computed, watch } from 'vue';
import { ChevronUpIcon, ChevronDownIcon } from '@heroicons/vue/20/solid';
import { useLabel } from '@/composables/useLabel';

const { label } = useLabel();

const props = defineProps<{
  modelValue: string | null;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
  minuteStep?: number;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'blur'): void;
}>();

const display = ref(props.modelValue ?? '');
const open = ref(false);
watch(
  () => props.modelValue,
  (v) => {
    const s = v ?? '';
    if (s !== display.value) display.value = s;
  },
);

const pad = (n: number) => String(n).padStart(2, '0');

// Interpret a value into hour/minute. An explicit colon locks the hour|minute boundary (so '1:00'
// is 1:00, not 10:); without one, a two-digit lead > 23 is read as a single-digit hour (900 → 9:00).
function parse(s: string): { h: number; m: number } {
  const colon = s.indexOf(':');
  if (colon >= 0) {
    const h = s.slice(0, colon).replace(/\D/g, '').slice(0, 2);
    let m = s.slice(colon + 1).replace(/\D/g, '').slice(0, 2);
    // A lone minute digit is the tens place (typed left-to-right): '3' means 30, not 03.
    if (m.length === 1) m += '0';
    return { h: Math.min(23, Number(h || 0)), m: Math.min(59, Number(m || 0)) };
  }
  const d = s.replace(/\D/g, '').slice(0, 4);
  if (d.length <= 2) return { h: Math.min(23, Number(d || 0)), m: 0 };
  const twoDigitHour = Number(d.slice(0, 2)) <= 23;
  const h = twoDigitHour ? d.slice(0, 2) : d.slice(0, 1);
  const m = (twoDigitHour ? d.slice(2) : d.slice(1)).slice(0, 2);
  return { h: Math.min(23, Number(h)), m: Math.min(59, Number(m || 0)) };
}

// Greedily split a bare digit run into hour/minute, marking each field "done" as soon as no further
// digit can extend it: a lead 3–9 is a single-digit hour, and a minute lead 6–9 is a single minute.
function smartSplit(d: string): { h: string; m: string; hourDone: boolean; minDone: boolean } {
  if (!d) return { h: '', m: '', hourDone: false, minDone: false };
  let h: string;
  let rest: string;
  let hourDone: boolean;
  if (Number(d[0]) >= 3) {
    h = d[0];
    rest = d.slice(1);
    hourDone = true;
  } else if (d.length >= 2) {
    const twoDigit = Number(d.slice(0, 2)) <= 23;
    h = twoDigit ? d.slice(0, 2) : d[0];
    rest = twoDigit ? d.slice(2) : d.slice(1);
    hourDone = true;
  } else {
    h = d;
    rest = '';
    hourDone = false;
  }
  if (!hourDone || rest.length === 0) return { h, m: '', hourDone, minDone: false };
  const m = Number(rest[0]) >= 6 ? rest[0] : rest.slice(0, 2);
  return { h, m, hourDone: true, minDone: Number(rest[0]) >= 6 || rest.length >= 2 };
}

// Reformat raw input into the live display. A fully-determined time normalizes to a padded HH:MM
// at once; a partial keeps the colon it has already earned. A typed colon is honoured as the
// hour|minute boundary. Deletion never pads or re-adds a colon, so backspacing stays clean.
function format(raw: string, deleting: boolean): string {
  const colon = raw.indexOf(':');
  if (colon >= 0) {
    const h = raw.slice(0, colon).replace(/\D/g, '').slice(0, 2);
    if (!h) return '';
    const m = raw.slice(colon + 1).replace(/\D/g, '').slice(0, 2);
    const minDone = m.length >= 2 || (m.length === 1 && Number(m) >= 6);
    return !deleting && minDone ? `${pad(Number(h))}:${pad(Number(m))}` : `${h}:${m}`;
  }
  const d = raw.replace(/\D/g, '').slice(0, 4);
  if (deleting) return d.length <= 2 ? d : `${d.slice(0, 2)}:${d.slice(2)}`;
  const s = smartSplit(d);
  if (!s.hourDone) return s.h;
  if (s.minDone) return `${pad(Number(s.h))}:${pad(Number(s.m))}`;
  return `${s.h}:${s.m}`;
}

const parts = computed(() => parse(display.value));

function commit(hh: number, mm: number) {
  display.value = `${pad(hh)}:${pad(mm)}`;
  emit('update:modelValue', display.value);
}

function bumpHour(delta: number) {
  commit((parts.value.h + delta + 24) % 24, parts.value.m);
}
function bumpMinute(delta: number) {
  const step = props.minuteStep ?? 5;
  const total = (parts.value.h * 60 + parts.value.m + delta * step + 1440) % 1440;
  commit(Math.floor(total / 60), total % 60);
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  const deleting = ((e as InputEvent).inputType || '').startsWith('delete');
  display.value = format(el.value, deleting);
  el.value = display.value;
  emit('update:modelValue', display.value);
}

function normalize() {
  display.value = /\d/.test(display.value) ? `${pad(parts.value.h)}:${pad(parts.value.m)}` : '';
  emit('update:modelValue', display.value);
}

// Blur fires when focus leaves the whole component (the popover buttons keep focus via
// mousedown.prevent), so this both closes the popover and normalizes the typed value.
function onBlur(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  if (next && (e.currentTarget as HTMLElement).contains(next)) return;
  open.value = false;
  normalize();
  emit('blur');
}
</script>

<template>
  <div class="relative inline-flex" @focusout="onBlur">
    <input
      :id="id"
      :value="display"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      :placeholder="placeholder ?? 'hh:mm'"
      :class="[
        'w-24 rounded-md border px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent',
        invalid ? 'border-destructive' : 'border-border',
      ]"
      @input="onInput"
      @focus="open = true"
      @click="open = true"
      @keydown.escape="open = false"
      @keydown.up.prevent="bumpHour(1)"
      @keydown.down.prevent="bumpHour(-1)"
    />

    <div
      v-if="open"
      class="absolute left-0 top-full z-50 mt-1 flex items-center gap-2 rounded-md border border-border bg-card p-2 shadow-lg"
      @mousedown.prevent
    >
      <div class="flex flex-col items-center">
        <button type="button" tabindex="-1" class="rounded p-0.5 text-neutral hover:bg-surface"
          :aria-label="label({ es: '+ hora', en: '+ hour' })" @click="bumpHour(1)">
          <ChevronUpIcon class="h-5 w-5" />
        </button>
        <span class="w-8 text-center text-sm font-semibold tabular-nums">{{ pad(parts.h) }}</span>
        <button type="button" tabindex="-1" class="rounded p-0.5 text-neutral hover:bg-surface"
          :aria-label="label({ es: '- hora', en: '- hour' })" @click="bumpHour(-1)">
          <ChevronDownIcon class="h-5 w-5" />
        </button>
      </div>
      <span class="text-sm font-semibold text-neutral">:</span>
      <div class="flex flex-col items-center">
        <button type="button" tabindex="-1" class="rounded p-0.5 text-neutral hover:bg-surface"
          :aria-label="label({ es: '+ minutos', en: '+ minutes' })" @click="bumpMinute(1)">
          <ChevronUpIcon class="h-5 w-5" />
        </button>
        <span class="w-8 text-center text-sm font-semibold tabular-nums">{{ pad(parts.m) }}</span>
        <button type="button" tabindex="-1" class="rounded p-0.5 text-neutral hover:bg-surface"
          :aria-label="label({ es: '- minutos', en: '- minutes' })" @click="bumpMinute(-1)">
          <ChevronDownIcon class="h-5 w-5" />
        </button>
      </div>
    </div>
  </div>
</template>
