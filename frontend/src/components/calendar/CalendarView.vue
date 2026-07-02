<script setup lang="ts">
import FullCalendar from '@fullcalendar/vue3';
import type { CalendarOptions, EventDropArg, EventResizeDoneArg, DateSelectArg, EventClickArg } from '@fullcalendar/core';

// Thin shared facade — all FullCalendar options and event data come from the parent.
// Role-scoped querying and editable flag are the parent's responsibility.
const props = defineProps<{
  options: CalendarOptions;
}>();

defineEmits<{
  select: [arg: DateSelectArg];
  eventClick: [arg: EventClickArg];
  eventDrop: [arg: EventDropArg];
  eventResize: [arg: EventResizeDoneArg];
}>();

// Suppress unused-props lint: options is forwarded to FullCalendar directly.
void props;
</script>

<template>
  <div class="fc-wrapper">
    <FullCalendar :options="options" />
  </div>
</template>

<style scoped>
.fc-wrapper {
  width: 100%;
}

:deep(.fc-day-count-badge) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  background: var(--color-accent, #2563eb);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 0 4px;
  margin-top: 2px;
}
</style>
