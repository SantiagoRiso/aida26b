<script setup lang="ts">
// Single source of date entry: always renders dd/mm/aaaa regardless of the browser's
// locale (native <input type="date"> follows the browser UI language, which we can't override).
// Binds ISO 'yyyy-MM-dd' strings so the value contract with the API is unchanged.
import { computed } from 'vue';
import { VueDatePicker } from '@vuepic/vue-datepicker';
import { es, enUS } from 'date-fns/locale';
import { useUiStore } from '@/stores/ui';

const props = defineProps<{
  modelValue: string | null;
  min?: string | null;
  max?: string | null;
  id?: string;
  placeholder?: string;
  invalid?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'blur'): void;
}>();

const ui = useUiStore();

// min/max arrive as ISO date strings; build a local Date from the parts so a negative-offset
// timezone can't shift the boundary a day earlier (new Date('yyyy-mm-dd') parses as UTC).
function toLocalDate(iso?: string | null): Date | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const minDate = computed(() => toLocalDate(props.min));
const maxDate = computed(() => toLocalDate(props.max));

// v14 requires a date-fns Locale object, not a language string.
const dpLocale = computed(() => (ui.language === 'en' ? enUS : es));
</script>

<template>
  <VueDatePicker
    :uid="id"
    :model-value="modelValue || null"
    model-type="yyyy-MM-dd"
    :formats="{ input: 'dd/MM/yyyy' }"
    :time-config="{ enableTimePicker: false }"
    :min-date="minDate"
    :max-date="maxDate"
    :locale="dpLocale"
    :dark="ui.theme === 'dark'"
    :input-class-name="invalid ? 'dp-invalid' : ''"
    teleport="body"
    auto-apply
    :text-input="{ format: 'dd/MM/yyyy', enterSubmit: true, tabSubmit: true, selectOnFocus: true }"
    :input-attrs="{ clearable: true }"
    :placeholder="placeholder ?? 'dd/mm/aaaa'"
    @update:model-value="emit('update:modelValue', ($event as string | null) ?? '')"
    @blur="emit('blur')"
  />
</template>
