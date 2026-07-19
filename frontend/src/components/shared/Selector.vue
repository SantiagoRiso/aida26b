<script setup lang="ts" generic="T extends SelectOption">
import { computed, watch } from 'vue';
import {
  Combobox,
  ComboboxInput,
  ComboboxButton,
  ComboboxOptions,
  ComboboxOption,
} from '@headlessui/vue';
import { ChevronUpDownIcon, CheckIcon } from '@heroicons/vue/20/solid';
import { ref } from 'vue';
import { i18n } from '@/i18n';

// Uses the global i18n instance (not useI18n()) — this component is mounted standalone in
// tests without the i18n plugin installed, and the global composer works either way.

export interface SelectOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    options: T[];
    searchable?: boolean;
    // A lone option isn't a choice: render it as a read-only label and auto-select it.
    labelIfSingle?: boolean;
    // Hard lock to the current value (context forces it, e.g. booking for a specific client).
    readonly?: boolean;
    // Soft pre-selection: applied only when nothing is chosen yet and the value exists in the
    // options, then left editable — a suggestion, not a lock.
    defaultValue?: string | null;
    placeholder?: string;
    showEmptyOption?: boolean;
    disabled?: boolean;
    id?: string;
    // Extra text to match against besides the label (searchable only), e.g. a professional's services.
    extraSearch?: (option: T) => string;
  }>(),
  {
    searchable: false,
    labelIfSingle: true,
    readonly: false,
    defaultValue: null,
    placeholder: '',
    showEmptyOption: true,
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
}>();

const query = ref('');

const selectedValue = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

// The sole option, when collapsing is enabled — this is the only case that locks by absence of choice.
const single = computed(() =>
  props.labelIfSingle && props.options.length === 1 ? props.options[0] : null,
);
const showAsLabel = computed(() => props.readonly || single.value != null);

function labelFor(value: string | null): string {
  if (value == null) return '';
  return props.options.find((o) => o.value === value)?.label ?? '';
}
const labelText = computed(() => (single.value ? single.value.label : labelFor(props.modelValue)));

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => {
    if (o.label.toLowerCase().includes(q)) return true;
    return props.extraSearch ? props.extraSearch(o).toLowerCase().includes(q) : false;
  });
});

// The query is a transient filter, not state: once a choice is made (or the input is left),
// reopening must show the full list, not the leftover filter.
watch(
  () => props.modelValue,
  () => {
    query.value = '';
  },
);

// Reconcile the bound value with the options: auto-select a lone option (locked), otherwise apply a
// soft default when nothing is chosen. Guarded so it only emits when the value actually changes.
watch(
  [() => props.options, () => props.modelValue, () => props.defaultValue, () => props.labelIfSingle],
  () => {
    if (single.value) {
      if (props.modelValue !== single.value.value) emit('update:modelValue', single.value.value);
      return;
    }
    if (
      props.defaultValue != null &&
      props.modelValue == null &&
      props.options.some((o) => o.value === props.defaultValue)
    ) {
      emit('update:modelValue', props.defaultValue);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="showAsLabel"
    :id="id"
    class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-neutral"
  >
    {{ labelText || placeholder }}
  </div>

  <Combobox
    v-else-if="searchable"
    v-model="selectedValue"
    :disabled="disabled"
    nullable
    as="div"
    class="relative"
  >
    <div class="relative">
      <ComboboxInput
        :id="id"
        class="w-full rounded-md border border-border bg-card px-3 py-2 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-surface disabled:text-neutral"
        :placeholder="placeholder"
        :display-value="(v) => labelFor(v as string | null)"
        autocomplete="off"
        @change="query = ($event.target as HTMLInputElement).value"
        @blur="query = ''"
      />
      <ComboboxButton class="absolute inset-y-0 right-0 flex items-center px-2" :aria-label="i18n.global.t('selector.openOptions')">
        <ChevronUpDownIcon class="h-5 w-5 text-neutral" aria-hidden="true" />
      </ComboboxButton>
    </div>

    <ComboboxOptions
      class="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-card py-1 text-sm shadow-lg focus:outline-none"
    >
      <div v-if="filtered.length === 0" class="px-3 py-2 text-neutral">
        <slot name="empty">{{ i18n.global.t('selector.noResults') }}</slot>
      </div>
      <ComboboxOption
        v-for="option in filtered"
        :key="option.value"
        v-slot="{ active, selected }"
        :value="option.value"
        as="template"
      >
        <li class="flex cursor-pointer items-start gap-2 px-3 py-2" :class="active ? 'bg-accent/10' : ''">
          <CheckIcon
            class="mt-0.5 h-4 w-4 flex-shrink-0"
            :class="selected ? 'text-accent' : 'invisible'"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <slot name="option" :option="option" :active="active" :selected="selected">
              <span :class="selected ? 'font-semibold' : ''">{{ option.label }}</span>
            </slot>
          </div>
        </li>
      </ComboboxOption>
    </ComboboxOptions>
  </Combobox>

  <select
    v-else
    :id="id"
    :value="modelValue ?? ''"
    :disabled="disabled"
    class="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value || null)"
  >
    <option v-if="showEmptyOption" value="" disabled>{{ placeholder }}</option>
    <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
  </select>
</template>
