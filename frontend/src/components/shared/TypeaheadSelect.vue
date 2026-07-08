<script setup lang="ts" generic="T extends TypeaheadOption">
import { computed, ref } from 'vue';
import {
  Combobox,
  ComboboxInput,
  ComboboxButton,
  ComboboxOptions,
  ComboboxOption,
} from '@headlessui/vue';
import { ChevronUpDownIcon, CheckIcon } from '@heroicons/vue/20/solid';

export interface TypeaheadOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    options: T[];
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    // Extra text to match against besides the label (e.g. the services a professional offers),
    // so typing a service name surfaces the professionals who provide it.
    extraSearch?: (option: T) => string;
  }>(),
  { placeholder: '', disabled: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
}>();

const query = ref('');

const selectedValue = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options;
  return props.options.filter((o) => {
    if (o.label.toLowerCase().includes(q)) return true;
    return props.extraSearch ? props.extraSearch(o).toLowerCase().includes(q) : false;
  });
});

function labelFor(value: string | null): string {
  if (value == null) return '';
  return props.options.find((o) => o.value === value)?.label ?? '';
}
</script>

<template>
  <Combobox
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
      />
      <ComboboxButton class="absolute inset-y-0 right-0 flex items-center px-2" aria-label="Abrir opciones">
        <ChevronUpDownIcon class="h-5 w-5 text-neutral" aria-hidden="true" />
      </ComboboxButton>
    </div>

    <ComboboxOptions
      class="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-card py-1 text-sm shadow-lg focus:outline-none"
    >
      <div v-if="filtered.length === 0" class="px-3 py-2 text-neutral">
        <slot name="empty">Sin resultados</slot>
      </div>
      <ComboboxOption
        v-for="option in filtered"
        :key="option.value"
        v-slot="{ active, selected }"
        :value="option.value"
        as="template"
      >
        <li
          class="flex cursor-pointer items-start gap-2 px-3 py-2"
          :class="active ? 'bg-accent/10' : ''"
        >
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
</template>
