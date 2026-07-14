<script setup lang="ts">
// Presentational calendar shell: merges the base FullCalendar options with every background-event
// layer (past wash, availability shading, slot outlines, exceptions, closures, hover, drag targets)
// derived from props. All state and data fetching stay in the parent view.
import { ref, computed } from 'vue';
import type { CalendarOptions, EventInput } from '@fullcalendar/core';
import CalendarViewComponent from '@/components/calendar/CalendarView.vue';
import { toMinutes, toHHMM, mergeIntervals } from '@shared/ssot/domain/availability';
import { complementIntervals } from '@/composables/calendarGrid';
import { nextDay } from '@/composables/scheduleExceptions';
import { dayISO, availabilityWashEvents, pastWashEvent, slotOutlineEventsForDay, DAY_END_MINUTES } from '@/composables/availabilityShading';
import type { BookedDay, MinuteInterval } from '@/composables/availabilityShading';
import type { ProfessionalBlock } from '@/composables/useProfessionalBlocks';
import type { BusinessClosure } from '@/api/closures';

// 'closed' (doesn't work that day) and 'full' (works, no free slots) are told apart so the
// month-view block message is honest.
export type DayAvailability = 'free' | 'full' | 'closed';

const props = defineProps<{
  baseOptions: CalendarOptions;
  fineDrag: boolean;
  currentViewType: string;
  visibleRange: { from: string; to: string };
  professionalId: number | null;
  resourceId: number | null;
  professionalBlocks: ProfessionalBlock[];
  businessClosures: BusinessClosure[];
  monthAvailability: Map<string, DayAvailability>;
  resourceFreeByDay: Map<string, MinuteInterval[]>;
  professionalFreeByDay: Map<string, MinuteInterval[]>;
  bookedByDate: Map<string, BookedDay>;
  highlightStartsByDay: Map<string, string[]>;
  dragTarget: { date: string; minutes: number } | null;
  dragDurationMinutes: number;
  slotMinutes: number | null;
  slotStartsMinutes: number[] | null;
  exceptionBgEvents: EventInput[];
  hoverEvents: EventInput[];
  hoverPreviewEvents: EventInput[];
  cellElapsed: (date: string, endMin: number) => boolean;
  slotBookableByAvailability: (date: string, startMin: number, endMin: number) => boolean;
}>();

const emit = defineEmits<{
  datesSet: [info: { startStr: string; endStr: string; view: { type: string } }];
}>();

// One dotted outline per real schedule slot, always shown. Timegrid only. Sobreturno mode books
// off the lattice, so the grid is hidden there — the free-click placement replaces it.
// Past slots aren't outlined (the grey past wash carries the day), and only slots the day's
// availability still offers qualify — this drops booked slots (the appointment block covers them)
// AND time-off (a licencia/feriado), so a holiday no longer advertises bookable slots.
const slotOutlineEvents = computed<EventInput[]>(() => {
  const profId = props.professionalId;
  if (props.fineDrag || profId == null || !props.professionalBlocks.length || !props.currentViewType.startsWith('timeGrid')) return [];
  const out: EventInput[] = [];
  let d = new Date(`${props.visibleRange.from}T00:00:00`);
  const end = new Date(`${props.visibleRange.to}T00:00:00`);
  while (d < end) {
    const date = dayISO(d, 0);
    out.push(...slotOutlineEventsForDay(date, props.professionalBlocks,
      (s, e) => !props.cellElapsed(date, e) && props.slotBookableByAvailability(date, s, e)));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
});

// Valid drop targets for the in-flight drag, one distinct box per open slot. Each box spans the
// professional's slot size (falling back to the appointment length in the mixed view). Empty
// except while dragging.
const backgroundEvents = computed<EventInput[]>(() => {
  const boxMinutes = props.slotMinutes ?? props.dragDurationMinutes;
  const out: EventInput[] = [];
  for (const [date, starts] of props.highlightStartsByDay) {
    for (const start of starts) {
      const endMin = toMinutes(start) + boxMinutes;
      out.push({
        start: `${date}T${start}:00`,
        end: `${date}T${toHHMM(endMin)}:00`,
        display: 'background',
        classNames: ['fc-slot-free'],
      });
    }
  }
  return out;
});

// The slot the drag is currently over, highlighted brighter than the open-slot boxes.
const targetEvents = computed<EventInput[]>(() => {
  if (!props.dragTarget) return [];
  const { date, minutes } = props.dragTarget;
  return [{
    start: `${date}T${toHHMM(minutes)}:00`,
    end: `${date}T${toHHMM(minutes + props.dragDurationMinutes)}:00`,
    display: 'background',
    classNames: ['fc-slot-target'],
  }];
});

// The minute of today where "past" ends and "present" begins — the START of the cell containing now
// (now floored to the slot grid), NOT the exact minute. This keeps the current cell whole: it reads
// as present (striped if unavailable, white/booked if available) instead of being split flat/striped
// by a mid-cell boundary. Falls back to the exact minute when no grid is known (mixed 'Todos' view).
const todayShadeFloor = computed(() => {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const gran = props.slotMinutes;
  const starts = props.slotStartsMinutes;
  if (!gran || !starts || starts.length === 0) return nowMin;
  const anchor = Math.min(...starts);
  if (nowMin <= anchor) return nowMin;
  return anchor + Math.floor((nowMin - anchor) / gran) * gran;
});

// Lower bound (minutes from midnight) below which availability shading is suppressed: past time
// reads plain, since it can't be booked. A fully-past day returns null (skip it entirely). Today
// transitions at the current cell's start so the current cell isn't split. The upper bound is the
// full day — FullCalendar clips background events to the visible grid, and the grid's lattice-aligned
// top can sit below the working-hours bound, so covering to 24h avoids an ungrayed strip.
function shadeFloorMinutes(date: string): number | null {
  const today = dayISO(new Date(), 0);
  if (date < today) return null;
  if (date === today) return todayShadeFloor.value;
  return 0;
}

// Resource availability overlay: green = free windows, grey hatch = closed/blocked (the complement
// within the visible working range). Timegrid only — background fills are meaningless in month view.
// No free windows on a day → the whole range reads as blocked, which is the "no availability" cue.
const resourceBgEvents = computed<EventInput[]>(() => {
  if (props.resourceId == null || !props.currentViewType.startsWith('timeGrid')) return [];
  const out: EventInput[] = [];
  for (const [date, slots] of props.resourceFreeByDay) {
    const floor = shadeFloorMinutes(date);
    if (floor == null) continue;
    for (const w of mergeIntervals(slots)) {
      const start = Math.max(w.start, floor);
      if (start < w.end) {
        out.push({ start: `${date}T${toHHMM(start)}:00`, end: `${date}T${toHHMM(w.end)}:00`, display: 'background', classNames: ['fc-res-free'] });
      }
    }
    for (const g of complementIntervals(slots, floor, DAY_END_MINUTES)) {
      out.push({ start: `${date}T${toHHMM(g.start)}:00`, end: `${date}T${toHHMM(g.end)}:00`, display: 'background', classNames: ['fc-res-closed'] });
    }
  }
  return out;
});

// Grey the selected professional's unavailable time (closed hours, holidays, gaps) in the week/day
// grid — the complement of their free slots. Resource overlay takes precedence when a resource is
// filtered; no professional selected ('Todos') → nothing to shade.
const professionalBgEvents = computed<EventInput[]>(() => {
  if (props.resourceId != null) return [];
  if (props.professionalId == null || !props.currentViewType.startsWith('timeGrid')) return [];
  const out: EventInput[] = [];
  for (const [date, freeSlots] of props.professionalFreeByDay) {
    const floor = shadeFloorMinutes(date);
    if (floor == null) continue;
    const booked = props.bookedByDate.get(date) ?? { occupied: [], requested: [] };
    out.push(...availabilityWashEvents(date, freeSlots, booked, floor));
  }
  return out;
});

// Grey past time with a FLAT wash — distinct from the striped availability overlay. Past can't be
// booked, so it's de-emphasized rather than marked "closed": whole past days, and today up to the
// START of the current cell (same transition as the availability shading, so the current cell isn't
// split). Every timegrid view, independent of the professional/resource filter.
const pastBgEvents = computed<EventInput[]>(() => {
  if (!props.currentViewType.startsWith('timeGrid')) return [];
  const today = dayISO(new Date(), 0);
  const out: EventInput[] = [];
  let d = new Date(`${props.visibleRange.from}T00:00:00`);
  const end = new Date(`${props.visibleRange.to}T00:00:00`);
  while (d < end) {
    const ev = pastWashEvent(dayISO(d, 0), today, todayShadeFloor.value);
    if (ev) out.push(ev);
    d = new Date(d.getTime() + 86400000);
  }
  return out;
});

// Business closures as background bands — full-day (00:00–24:00) or the partial [start, end) window.
// Rendered on every view/filter (feriados close the whole business); appointments stay on top as
// foreground events. Distinct class from the per-owner exception overlay so a clinic holiday reads
// apart from one professional's day off.
const closureBgEvents = computed<EventInput[]>(() => {
  const { from, to } = props.visibleRange;
  const out: EventInput[] = [];
  for (const c of props.businessClosures) {
    if (c.exception_date < from || c.exception_date >= to) continue;
    const base = { display: 'background' as const, classNames: ['fc-closure'], title: c.reason ?? '', extendedProps: { closure: c } };
    if (!c.start_time || !c.end_time) {
      out.push({ ...base, start: `${c.exception_date}T00:00:00`, end: `${nextDay(c.exception_date)}T00:00:00` });
    } else {
      out.push({ ...base, start: `${c.exception_date}T${c.start_time.slice(0, 5)}:00`, end: `${c.exception_date}T${c.end_time.slice(0, 5)}:00` });
    }
  }
  return out;
});

// Must stay a computed (not a plain spread object) — FullCalendar's Vue wrapper only
// re-diffs options when the prop reference changes; a plain object built once at setup
// freezes `events` to whatever appointments held at that instant.
const fullOptions = computed<CalendarOptions>(() => {
  // Read here so the computed re-runs (and FC re-renders the graying) when the map is replaced.
  const monthAvail = props.monthAvailability;
  // Sobreturno mode makes full days bookable, so they must not read as disabled/greyed either.
  const fine = props.fineDrag;
  const baseViews: NonNullable<CalendarOptions['views']> = props.baseOptions.views ?? {};
  return {
    ...props.baseOptions,
    // Fill the flex-1 calendar slot (see template) so the coarse appointment-sized rows expand to use
    // the available vertical space instead of leaving a gap below a short grid.
    height: '100%',
    events: [
      ...((props.baseOptions.events as EventInput[]) ?? []),
      ...pastBgEvents.value,
      ...resourceBgEvents.value,
      ...professionalBgEvents.value,
      ...slotOutlineEvents.value,
      ...props.exceptionBgEvents,
      ...closureBgEvents.value,
      ...props.hoverEvents,
      ...props.hoverPreviewEvents,
      ...backgroundEvents.value,
      ...targetEvents.value,
    ],
    views: {
      ...baseViews,
      // Timegrid booking goes through our own slot click/hover (useGridInteraction), so FC's native cell
      // select is off here — it would otherwise fire on click with a 30-min-cell time (not the real
      // slot) and draw its own cell highlight over the dotted slot. Month keeps select (day click).
      timeGridWeek: { selectable: false },
      timeGridDay: { selectable: false },
      dayGridMonth: {
        ...(baseViews.dayGridMonth ?? {}),
        // Dim days the selected professional has no free slots on (closed or fully booked),
        // except in sobreturno mode where those days stay bookable.
        dayCellClassNames: (arg: { date: Date }) => {
          const s = monthAvail.get(dayISO(arg.date, 0));
          return !fine && (s === 'full' || s === 'closed') ? ['fc-day-unavailable'] : [];
        },
      },
    },
    datesSet: (info: { startStr: string; endStr: string; view: { type: string } }) => {
      emit('datesSet', info);
    },
  };
});

// Forward the rendered root element — the parent's custom drag and grid interaction read the
// timegrid DOM (columns, slot lanes) through it to map pointer position to calendar time.
const calendar = ref<InstanceType<typeof CalendarViewComponent> | null>(null);
defineExpose({
  getRootEl: (): HTMLElement | null => calendar.value?.getRootEl() ?? null,
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card p-3 shadow-sm">
    <CalendarViewComponent ref="calendar" :options="fullOptions" class="min-h-0 flex-1" />
  </div>
</template>
