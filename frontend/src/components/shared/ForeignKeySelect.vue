<script setup lang="ts">
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import type { ForeignKeyDef } from '@shared/types/types';
import Selector from '@/components/shared/Selector.vue';

// One picker for every referenced id, in a form or in a filter: the typed text is answered by
// the server, so a value past the first page stays selectable.
const props = defineProps<{
  foreignKey: ForeignKeyDef;
  modelValue: string | null;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string | null];
  blur: [];
}>();

const { options, loading, search } = useForeignKeyOptions(props.foreignKey);
</script>

<template>
  <Selector
    :id="id"
    searchable
    :label-if-single="false"
    :model-value="modelValue"
    :options="options"
    :loading="loading"
    :placeholder="placeholder"
    :disabled="disabled"
    @search="search"
    @update:model-value="emit('update:modelValue', $event); emit('blur')"
  />
</template>
