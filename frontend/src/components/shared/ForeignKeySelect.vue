<script setup lang="ts">
import { computed, watch } from 'vue';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { i18n } from '@/i18n';
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

const { options, loading, search, resolve, isUnresolved } = useForeignKeyOptions(props.foreignKey);

// An edit form opens on a value nobody typed a query for: fetch it so the field shows what is
// set instead of an empty box that reads as "nothing selected".
watch(() => props.modelValue, (value) => { resolve(value); }, { immediate: true });

const missingLabel = computed(() =>
  isUnresolved(props.modelValue) ? i18n.global.t('generic.unresolvedReference') : '',
);
</script>

<template>
  <Selector
    :id="id"
    searchable
    :label-if-single="false"
    :model-value="modelValue"
    :options="options"
    :loading="loading"
    :missing-label="missingLabel"
    :placeholder="placeholder"
    :disabled="disabled"
    @search="search"
    @update:model-value="emit('update:modelValue', $event); emit('blur')"
  />
</template>
