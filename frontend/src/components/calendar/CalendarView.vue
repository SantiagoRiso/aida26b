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

/* The first line identifies the client beside the time; room and service use the remaining height. */
:deep(.fc-ev-compact) {
  display: block;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.3;
  padding: 1px 3px;
}

:deep(.fc-ev-primary),
:deep(.fc-ev-details) {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

:deep(.fc-ev-details) {
  font-size: 11px;
  opacity: 0.9;
}

/* Only appointment labels are white on a professional colour, so only they get the crispening shadow.
   Exception overlays (holidays / days-off) and the sobreturno ghost use dark text on a light wash — a
   shadow there would just muddy them. */
:deep([class*='appt-state-'] .fc-ev-compact) {
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
}

:deep(.fc-ev-compact .fc-ev-time) {
  font-weight: 600;
}

:deep(.fc-timegrid-event .fc-event-main) {
  overflow: hidden;
  padding: 0;
}

/* FullCalendar rings each timegrid event with a 1px white halo (--fc-page-bg-color) to separate
   neighbours. It's invisible on the white grid but shows as a faint white border over the grey past
   wash. The events already carry a 1px coloured border, so drop the ring. The radius matches the slots
   (8px) so every block on the grid shares one corner radius.
   The 1.5px side margin pairs with the events-container override below: together they inset every
   appointment 3px per side — matching the slots — while giving two appointments that share a slot a
   real 3px gap at the split instead of touching. */
:deep(.fc-timegrid-event) {
  box-shadow: none;
  border-radius: 8px !important;
  margin: 0 1.5px;
}

/* FC insets the foreground-event container 2.5% on the right (headroom for its overlap halo) but 2px
   on the left, and the background slots get neither — so appointments sat several px narrower and
   off-centre versus the slot beneath them. Pin it to a symmetric 1.5px; the per-event margin adds the
   other 1.5px, landing every appointment on the slots' 3px inset. */
:deep(.fc-timegrid-col-events) {
  margin: 0 1.5px !important;
}


/* Permanent dotted outline for every real schedule slot inside a working block. Sits behind the
   appointments; makes the block's slot structure visible without cluttering the time axis. */
:deep(.fc-slot-outline) {
  background: rgba(37, 99, 235, 0.16) !important;
  border: 1.5px dashed rgb(37, 99, 235);
  border-radius: 8px;
  margin: 1.5px 3px;
  opacity: 1 !important;
}

/* The dotted slot outlines (inside blocks) and the grey non-working shading carry the structure now,
   so the uniform row lines are irrelevant — hide them (both the on-the-hour and half-hour lanes). The
   hour LABELS on the axis stay; only the horizontal grid lines go. */
:deep(.fc-timegrid-slot) {
  border-top-color: transparent;
}

/* Sobreturno hover preview: a translucent dashed block so it reads as a placement ghost, not a real
   turno. As a foreground event it shoves overlapping turnos aside (slotEventOverlap:false). */
:deep(.fc-sobreturno-preview) {
  background: rgba(37, 99, 235, 0.16) !important;
  border: 1.5px dashed rgb(37, 99, 235) !important;
  border-radius: 8px !important;
  color: rgb(30, 58, 138) !important;
  box-shadow: none !important;
}

:deep(.fc-drag-layout-preview) {
  opacity: 0 !important;
  pointer-events: none !important;
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

:deep(.fc-drag-target-overlay) {
  box-sizing: border-box;
}

:deep(.fc-drag-target-invalid) {
  background: rgba(239, 68, 68, 0.16) !important;
  border-color: rgb(220, 38, 38) !important;
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
    rgba(71, 85, 105, 0.11),
    rgba(71, 85, 105, 0.11) 6px,
    rgba(71, 85, 105, 0.03) 6px,
    rgba(71, 85, 105, 0.03) 12px
  ) !important;
  opacity: 1 !important;
}

/* Calendar-background occupancy washes: confirmed-booked is a flat slate; client-requested is amber.
   Blue is reserved for bookable/interactive slots (outline, hover, sobreturno ghost), so occupied
   stays off-blue. Off-hours is the grey hatch above — a pattern, not a flat fill. */
:deep(.fc-slot-occupied) {
  background: rgba(100, 116, 139, 0.2) !important;
  opacity: 1 !important;
}

:deep(.fc-slot-requested-bg) {
  background: rgba(234, 179, 8, 0.26) !important;
  opacity: 1 !important;
}

/* Past time — a flat neutral wash (no stripes) so it reads as de-emphasized/unbookable. */
:deep(.fc-slot-past) {
  background: rgba(100, 116, 139, 0.18) !important;
  opacity: 1 !important;
}

/* Schedule exceptions (days off / partial blocks / extra-hours) — distinct from the plain
   fc-res-closed availability hatch so staff can tell "why" apart from ordinary non-working time. */
:deep(.fc-exception-off) {
  background: rgba(220, 38, 38, 0.14) !important;
  opacity: 1 !important;
}

:deep(.fc-exception-block) {
  background: repeating-linear-gradient(
    45deg,
    rgba(220, 38, 38, 0.20),
    rgba(220, 38, 38, 0.20) 6px,
    rgba(220, 38, 38, 0.06) 6px,
    rgba(220, 38, 38, 0.06) 12px
  ) !important;
  opacity: 1 !important;
}

:deep(.fc-exception-extra) {
  background: rgba(37, 99, 235, 0.12) !important;
  opacity: 1 !important;
}

/* Business-wide closure (feriado) — stronger, bolder diagonal hatch than a single professional's
   day-off wash, so a clinic-wide holiday is unmistakable on every calendar (incl. the mixed view). */
:deep(.fc-closure) {
  background: repeating-linear-gradient(
    -45deg,
    rgba(220, 38, 38, 0.28),
    rgba(220, 38, 38, 0.28) 8px,
    rgba(220, 38, 38, 0.14) 8px,
    rgba(220, 38, 38, 0.14) 16px
  ) !important;
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
  background: rgba(37, 99, 235, 0.16) !important;
  border: 1.5px dashed rgb(37, 99, 235);
  border-radius: 8px;
  margin: 1.5px 3px;
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

/* The flat, in-place drag preview (createDragGhost) — its look is set inline; nothing to add here. */

/* Three occupancy states must read at a glance:
   - not-working time      → the grey diagonal hatch (fc-res-closed): a low-contrast background wash.
   - already occupied      → the solid professional-colour block (the default appointment fill).
   - requested by a client → the same colour candy-striped (opposite diagonal to the not-working hatch)
                             + dashed border, so it reads as tentative / awaiting confirmation rather
                             than a taken slot. Closed states fade out. */
/* Requested (client-pending): the calendar background carries the main colour cue; the block adds a
   dashed border and very light, wide candy stripes — a whisper, not the earlier heavy pattern. */
:deep(.appt-state-requested) {
  border-style: dashed;
  border-width: 2px;
  background-image: repeating-linear-gradient(
    135deg,
    rgba(255, 255, 255, 0) 0,
    rgba(255, 255, 255, 0) 8px,
    rgba(255, 255, 255, 0.13) 8px,
    rgba(255, 255, 255, 0.13) 16px
  );
}

/* Sobreturno (override / overbooked): a Material alarm badge in the bottom-right and a light-blue
   time, so an overbooked slot is obvious on any professional colour. The icon is masked (not a
   background image) so it renders white on any fill. Anchors to FC's positioned event. */
:deep(.appt-sobreturno)::after {
  content: '';
  position: absolute;
  bottom: 1px;
  right: 2px;
  width: 13px;
  height: 13px;
  background-color: #fff;
  -webkit-mask: url('/icons/alarm.svg') center / contain no-repeat;
  mask: url('/icons/alarm.svg') center / contain no-repeat;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.7));
  pointer-events: none;
  z-index: 1;
}

:deep(.appt-sobreturno .fc-ev-time) {
  color: #7dd3fc;
}

/* In conflict with time off (a closure or the professional's licencia): a red ring + a bottom-left "!"
   badge so it stands out on any professional colour for triage. Bottom-left keeps clear of the event's
   time/title (top-left) and the sobreturno badge (bottom-right) — a turno can carry both. Computed;
   clears when the time off goes. */
:deep(.appt-in-conflict) {
  box-shadow: 0 0 0 2px rgb(220, 38, 38) !important;
}

:deep(.appt-in-conflict)::before {
  content: '!';
  position: absolute;
  bottom: 1px;
  left: 2px;
  width: 14px;
  height: 14px;
  line-height: 14px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: rgb(220, 38, 38);
  border-radius: 9999px;
  pointer-events: none;
  z-index: 2;
}

/* Virtual (recurring) occurrence: a Material repeat badge in the same bottom-right corner the
   sobreturno clock uses (a virtual is never a sobreturno, so they never share the spot). Masked so
   it renders white on any fill. The in-conflict "!" sits bottom-left, so a conflicting virtual can
   carry both. */
:deep(.fc-virtual-occurrence)::after {
  content: '';
  position: absolute;
  bottom: 1px;
  right: 2px;
  width: 13px;
  height: 13px;
  background-color: #fff;
  -webkit-mask: url('/icons/repeat.svg') center / contain no-repeat;
  mask: url('/icons/repeat.svg') center / contain no-repeat;
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.7));
  pointer-events: none;
  z-index: 1;
}

/* A virtual (un-materialized) recurring occurrence reads as a normal booked turno — solid fill and
   border in the professional's colour — set apart only by the repeat badge and a faint fade hinting
   it isn't a stored row yet. Deliberately NOT the dashed candy-stripe treatment used for pending
   requests. appt-in-conflict / appt-sobreturno still layer on top unchanged when a virtual carries them. */
:deep(.fc-virtual-occurrence) {
  opacity: 0.9;
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
