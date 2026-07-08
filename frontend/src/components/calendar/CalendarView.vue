<script setup lang="ts">
import { ref } from 'vue';
import FullCalendar from '@fullcalendar/vue3';
import type { CalendarApi } from '@fullcalendar/core';
import type { CalendarOptions, EventDropArg, DateSelectArg, EventClickArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';

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

// Expose the FullCalendar API and the rendered root element — the parent's custom drag reads the
// timegrid DOM (columns, slot lanes) through the wrapper to map pointer position to calendar time.
const fc = ref<InstanceType<typeof FullCalendar> | null>(null);
const wrapper = ref<HTMLElement | null>(null);
defineExpose({
  getApi: (): CalendarApi | undefined => fc.value?.getApi(),
  getRootEl: (): HTMLElement | null => wrapper.value,
});
</script>

<template>
  <div ref="wrapper" class="fc-wrapper">
    <FullCalendar ref="fc" :options="options" />
  </div>
</template>

<style scoped>
.fc-wrapper {
  width: 100%;
}

/* Short events get very little height — keep content on one clean ellipsized line. */
:deep(.fc-ev-compact) {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.3;
  padding: 1px 3px;
}

:deep(.fc-ev-compact .fc-ev-time) {
  font-weight: 600;
}

:deep(.fc-timegrid-event .fc-event-main) {
  overflow: hidden;
  padding: 0;
}

/* Valid drop target while dragging: a distinct dotted, rounded box per open slot. */
:deep(.fc-slot-free) {
  background: rgba(16, 185, 129, 0.12) !important;
  border: 1.5px dashed rgb(5, 150, 105);
  border-radius: 8px;
  margin: 1.5px 3px;
  opacity: 1 !important;
}

/* The slot the drag is currently over — brighter than the open-slot boxes. */
:deep(.fc-slot-target) {
  background: rgba(5, 150, 105, 0.28) !important;
  border: 2px solid rgb(5, 150, 105);
  border-radius: 8px;
  margin: 1.5px 3px;
  opacity: 1 !important;
}

/* Resource availability overlay (filtering by a resource): free windows tinted green,
   closed/blocked time hatched grey. Complementary, so they never overlap. */
:deep(.fc-res-free) {
  background: rgba(16, 185, 129, 0.10) !important;
  opacity: 1 !important;
}

:deep(.fc-res-closed) {
  background: repeating-linear-gradient(
    45deg,
    rgba(100, 116, 139, 0.16),
    rgba(100, 116, 139, 0.16) 6px,
    rgba(100, 116, 139, 0.05) 6px,
    rgba(100, 116, 139, 0.05) 12px
  ) !important;
  opacity: 1 !important;
}

/* Past time — a flat neutral wash (no stripes) so it reads as de-emphasized/unbookable. */
:deep(.fc-slot-past) {
  background: rgba(100, 116, 139, 0.18) !important;
  opacity: 1 !important;
}

/* Month day cells read as actionable. The timegrid cursor is driven from JS (onGridPointerMove)
   instead, so past slots don't show the actionable pointer. */
:deep(.fc-daygrid-day-frame) {
  cursor: pointer;
}

/* Week/day: a single slot cell under the cursor (driven by pointer geometry, not CSS :hover,
   since the timegrid has no per-cell element). Month: the whole day cell, which is one cell. */
:deep(.fc-slot-hover) {
  background: rgba(37, 99, 235, 0.13) !important;
  opacity: 1 !important;
}

:deep(.fc-daygrid-day:hover) {
  background: rgba(37, 99, 235, 0.13);
}

/* Month days the selected professional has no free slots on: dimmed and not actionable. */
:deep(.fc-day-unavailable) {
  background: rgba(100, 116, 139, 0.12);
}

:deep(.fc-day-unavailable .fc-daygrid-day-number) {
  opacity: 0.4;
}

:deep(.fc-day-unavailable .fc-daygrid-day-frame) {
  cursor: default;
}

:deep(.fc-day-unavailable:hover) {
  background: rgba(100, 116, 139, 0.14);
}

/* The block we drag ourselves (cloned onto <body> during a custom drag). */
:global(.fc-drag-ghost) {
  opacity: 0.85;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  cursor: grabbing;
}

/* State is visible on the block itself, not only in the detail panel:
   pending requests read as tentative; closed states fade out. */
:deep(.appt-state-requested) {
  border-style: dashed;
  border-width: 2px;
  opacity: 0.85;
}

:deep(.appt-state-canceled),
:deep(.appt-state-rejected),
:deep(.appt-state-no_show) {
  opacity: 0.45;
}

:deep(.appt-state-canceled .fc-ev-title),
:deep(.appt-state-rejected .fc-ev-title) {
  text-decoration: line-through;
}
</style>
