<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import CalendarFilters from '@/components/calendar/CalendarFilters.vue';
import type { FilterState } from '@/components/calendar/CalendarFilters.vue';

const props = defineProps<{
  canSobreturno: boolean;
  fineDrag: boolean;
}>();

const emit = defineEmits<{
  'update:filters': [filters: FilterState];
  'update:fineDrag': [value: boolean];
}>();

const { t } = useI18n();

const fine = computed({
  get: () => props.fineDrag,
  set: (v: boolean) => emit('update:fineDrag', v),
});
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <CalendarFilters @update:filters="emit('update:filters', $event)" />

    <label v-if="canSobreturno" class="inline-flex items-center gap-2 text-sm font-medium cursor-pointer">
      <input v-model="fine" type="checkbox" class="h-4 w-4 accent-accent" />
      {{ t('calendar.fineMode') }}
    </label>
  </div>
</template>
