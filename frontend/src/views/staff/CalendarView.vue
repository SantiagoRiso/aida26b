<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CalendarOptions, DateSelectArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useCustomDrag } from '@/composables/useCustomDrag';
import { useTimegridGeometry } from '@/composables/useTimegridGeometry';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { listAppointments, rescheduleAppointment, approveAppointment } from '@/api/appointments';
import { getAvailability } from '@/api/scheduling';
import type { Appointment } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import CalendarViewComponent from '@/components/calendar/CalendarView.vue';
import CalendarFilters from '@/components/calendar/CalendarFilters.vue';
import type { FilterState } from '@/components/calendar/CalendarFilters.vue';
import AppointmentDetailPanel from '@/components/calendar/AppointmentDetailPanel.vue';
import AppointmentForm from '@/components/calendar/AppointmentForm.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import AppButton from '@/components/shared/AppButton.vue';
import { useCurrency } from '@/composables/useCurrency';
import { computeValidStarts, resolveDrop, exceedsEndOfDay, mergeIntervals, complementIntervals, latticeFromFreeSlots } from '@/composables/calendarGrid';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();
const { formatDate } = useCurrency();

const appointments = ref<Appointment[]>([]);
const loading = ref(false);


// Ref to the calendar facade — exposes the rendered root element the custom drag reads (via geometry).
const calendarRef = ref<InstanceType<typeof CalendarViewComponent> | null>(null);

const visibleRange = ref<{ from: string; to: string }>({
  from: new Date().toISOString().slice(0, 10),
  to: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
});

const filters = ref<FilterState>({ professional_user_id: null, resource_id: null });

// Free slots per visible day for a filtered resource; drives the availability shading overlay.
const resourceFreeByDay = ref<Map<string, { start: number; end: number }[]>>(new Map());
// Current FullCalendar view (from datesSet) — the resource overlay only makes sense in timegrid.
const currentViewType = ref('timeGridWeek');

const detailAppt = ref<Appointment | null>(null);
const detailOpen = ref(false);

const formOpen = ref(false);
// Keep the form mounted through the close animation (cleared on @after-leave) so the panel
// doesn't blank mid-close; opening flips it true via the watcher below.
const formMounted = ref(false);
watch(formOpen, (open) => { if (open) formMounted.value = true; });
const formAppt = ref<Appointment | undefined>(undefined);
const formPrefillDate = ref<string | undefined>();
const formPrefillStart = ref<string | undefined>();
const formPrefillProfId = ref<number | undefined>();
const formPrefillResourceId = ref<number | undefined>();

const conflictOpen = ref(false);
const conflictVerdict = ref<ConflictVerdict | null>(null);
// Snap drag/resize back when the user cancels the override.
const conflictRevert = ref<(() => void) | null>(null);
const conflictRetryFn = ref<((override: boolean) => Promise<void>) | null>(null);

// Drag/resize is consequential — confirm the resolved slot before persisting.
const moveConfirmOpen = ref(false);
const moveConfirmBody = ref('');
const moveConfirmProceed = ref<(() => Promise<void>) | null>(null);
const moveConfirmRevert = ref<(() => void) | null>(null);

async function fetchAppointments() {
  loading.value = true;
  const result = await listAppointments({
    date_from: visibleRange.value.from,
    date_to: visibleRange.value.to,
    professional_user_id: filters.value.professional_user_id ?? undefined,
    resource_id: filters.value.resource_id ?? undefined,
    limit: 200,
  });
  loading.value = false;
  if (result.ok) {
    appointments.value = result.data as Appointment[];
    // Bookings changed → the visible professional's slot lattice (visual row sizing) is stale.
    void refreshSnapGrid();
    // …and a filtered resource's free/blocked shading depends on the same bookings.
    void loadResourceAvailability();
    // …and the month-view per-day availability (graying + click-to-book gating).
    void loadMonthAvailability();
  }
}

watch(filters, fetchAppointments, { immediate: true, deep: true });

// Untitled events read as the client's name — "Turno #id" says nothing to staff.
const { labelFor: clientLabelFor } = useForeignKeyOptions({
  table: 'clients', valueField: 'id', labelField: 'display_name',
});
const { labelFor: professionalLabelFor } = useForeignKeyOptions({
  table: 'professionals', valueField: 'id', labelField: 'display_name',
});
const { labelFor: serviceLabelFor } = useForeignKeyOptions({
  table: 'services', valueField: 'id', labelField: 'name',
});
function clientNameFor(appt: Appointment): string | null {
  return clientLabelFor(appt.client_user_id);
}
function tooltipFor(appt: Appointment): string {
  return [
    clientLabelFor(appt.client_user_id),
    professionalLabelFor(appt.professional_user_id),
    serviceLabelFor(appt.service_id),
    t(`status.${appt.state}`),
  ].filter(Boolean).join(' · ');
}

// Sobreturno mode: a persistent toggle (not a held key) so the snap step is fixed for the whole
// drag — FullCalendar locks its snap at drag start and won't change it in-flight. On → drag moves
// in free 5-min steps off the lattice; off → drag snaps to the professional's real slots.
const fineDrag = ref(false);

// Placing off the slot lattice (sobreturno) is a staff action; clients never reach this view.
// No dedicated per-action permission exists yet, so this mirrors the calendar's edit capability.
const canSobreturno = computed(() => !!auth.user && auth.user.role !== 'Client');
watch(canSobreturno, (ok) => { if (!ok) fineDrag.value = false; });

// Selected professional's real slot starts (minutes from midnight) across the visible days, plus
// their granularity — drives the live snap grid. Null when no single professional is selected.
const slotStartsMinutes = ref<number[] | null>(null);
const slotMinutes = ref<number | null>(null);

// Duration-aware valid drop targets for the appointment currently being dragged, keyed by day.
// Populated on drag start (excluding the dragged appointment), cleared on drag stop.
const highlightStartsByDay = ref<Map<string, string[]>>(new Map());
let dragDurationMinutes = 0;

function dayISO(base: Date, offset: number): string {
  const d = new Date(base.getTime() + offset * 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Fetch a professional's free slots for each visible day, all days in parallel so a hover pulls
// the week in ~one round-trip. `exclude` frees the dragged block's own span so it can be nudged
// near its current position.
async function loadSlotsByDay(profId: number, exclude?: number): Promise<Map<string, { start: string; end: string }[]>> {
  const base = new Date(`${visibleRange.value.from}T00:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => dayISO(base, i));
  const results = await Promise.all(dates.map((date) => getAvailability(`prof:${profId}`, date, exclude)));
  const byDay = new Map<string, { start: string; end: string }[]>();
  dates.forEach((date, i) => {
    const res = results[i];
    if (res.ok) byDay.set(date, res.data.slots);
  });
  return byDay;
}

// A professional's snap lattice from their free slots: real slot starts plus the finest slot
// length. Null when they have no slots in view.
function applyGrid(grid: { starts: number[] | null; minutes: number | null }) {
  slotStartsMinutes.value = grid.starts;
  slotMinutes.value = grid.minutes;
}

// Free intervals (minutes) per visible day for the selected professional — drives the availability
// overlay (grey = closed / unavailable) in the week/day grid.
const professionalFreeByDay = ref<Map<string, { start: number; end: number }[]>>(new Map());

// Size the visible grid rows to a selected professional's slot lattice AND capture their free time
// for the unavailable-shading overlay. The mixed 'Todos' view has no single professional → both empty.
async function refreshSnapGrid() {
  const profId = filters.value.professional_user_id;
  if (profId == null) {
    applyGrid({ starts: null, minutes: null });
    professionalFreeByDay.value = new Map();
    return;
  }
  const byDay = await loadSlotsByDay(profId);
  applyGrid(latticeFromFreeSlots([...byDay.values()].flat()));
  const map = new Map<string, { start: number; end: number }[]>();
  for (const [date, slots] of byDay) {
    map.set(date, slots.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) })));
  }
  professionalFreeByDay.value = map;
}

watch(() => filters.value.professional_user_id, refreshSnapGrid);
watch(visibleRange, refreshSnapGrid, { deep: true });

async function loadResourceAvailability() {
  const resId = filters.value.resource_id;
  if (resId == null) { resourceFreeByDay.value = new Map(); return; }
  const base = new Date(`${visibleRange.value.from}T00:00:00`);
  const dates = Array.from({ length: 7 }, (_, i) => dayISO(base, i));
  const results = await Promise.all(dates.map((date) => getAvailability(`res:${resId}`, date)));
  const byDay = new Map<string, { start: number; end: number }[]>();
  dates.forEach((date, i) => {
    const r = results[i];
    if (r.ok) byDay.set(date, r.data.slots.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) })));
  });
  resourceFreeByDay.value = byDay;
}

// Per-day availability for the visible month grid, only when a single professional is in view.
// Drives the "no availability" graying and gates click-to-book on empty days. 'closed' (doesn't
// work that day) and 'full' (works, no free slots) are told apart so the block message is honest.
type DayAvailability = 'free' | 'full' | 'closed';
const monthAvailability = ref<Map<string, DayAvailability>>(new Map());

async function loadMonthAvailability() {
  const profId = filters.value.professional_user_id;
  if (currentViewType.value !== 'dayGridMonth' || profId == null) {
    if (monthAvailability.value.size) monthAvailability.value = new Map();
    return;
  }
  const dates: string[] = [];
  let d = new Date(`${visibleRange.value.from}T00:00:00`);
  const end = new Date(`${visibleRange.value.to}T00:00:00`);
  // A month grid is at most 6 weeks; the cap is a safety bound, not a functional limit.
  while (d < end && dates.length < 42) {
    dates.push(dayISO(d, 0));
    d = new Date(d.getTime() + 86400000);
  }
  const results = await Promise.all(dates.map((date) => getAvailability(`prof:${profId}`, date)));
  const map = new Map<string, DayAvailability>();
  dates.forEach((date, i) => {
    const r = results[i];
    if (r.ok) map.set(date, r.data.slots.length > 0 ? 'free' : r.data.open ? 'full' : 'closed');
  });
  monthAvailability.value = map;
}

// Valid drop targets for the in-flight drag, one distinct box per open slot. Each box spans the
// professional's slot size (falling back to the appointment length in the mixed view). Empty
// except while dragging.
const backgroundEvents = computed<EventInput[]>(() => {
  const boxMinutes = slotMinutes.value ?? dragDurationMinutes;
  const out: EventInput[] = [];
  for (const [date, starts] of highlightStartsByDay.value) {
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
const dragTarget = ref<{ date: string; minutes: number } | null>(null);

// Per-cell hover highlight for the timegrid (mirrors the month view's per-day-cell hover). Suppressed
// while dragging so it doesn't compete with the drag target.
const hoverTarget = ref<{ date: string; startMin: number; endMin: number } | null>(null);
const isDragging = ref(false);

// A completed drag emits a trailing click; swallow it once so it doesn't also open the detail panel.
// Cleared on the next event press, so it can never suppress an unrelated later click.
let suppressEventClick = false;
const targetEvents = computed<EventInput[]>(() => {
  if (!dragTarget.value) return [];
  const { date, minutes } = dragTarget.value;
  return [{
    start: `${date}T${toHHMM(minutes)}:00`,
    end: `${date}T${toHHMM(minutes + dragDurationMinutes)}:00`,
    display: 'background',
    classNames: ['fc-slot-target'],
  }];
});

// The single slot cell the cursor is over (week/day view) — a discrete highlight like the month grid.
const hoverEvents = computed<EventInput[]>(() => {
  if (!hoverTarget.value) return [];
  const { date, startMin, endMin } = hoverTarget.value;
  return [{
    start: `${date}T${toHHMM(startMin)}:00`,
    end: `${date}T${toHHMM(endMin)}:00`,
    display: 'background',
    classNames: ['fc-slot-hover'],
  }];
});

function isoToMinutes(iso: string | null): number {
  if (!iso) return NaN;
  const [h, m] = iso.split(':').map(Number);
  return h * 60 + m;
}

// Map the cursor to the day column + slot row under it and highlight that one cell. Reads the lane
// rows straight from the DOM so the box lands exactly on the rendered grid (any granularity).
function onGridPointerMove(ev: PointerEvent) {
  const root = calendarRef.value?.getRootEl();
  // Cursor is driven here (the timegrid CSS no longer sets it) so past cells don't look actionable.
  const reset = () => { hoverTarget.value = null; if (root) root.style.cursor = ''; };
  if (isDragging.value || !currentViewType.value.startsWith('timeGrid')) { reset(); return; }
  if (!root) { hoverTarget.value = null; return; }
  const col = geometry.columnAt(ev.clientX);
  if (!col) { reset(); return; }

  const seen = new Set<number>();
  const lanes = [...root.querySelectorAll<HTMLElement>('.fc-timegrid-slot-lane[data-time]')]
    .map((el) => ({ top: el.getBoundingClientRect().top, min: isoToMinutes(el.getAttribute('data-time')) }))
    .filter((l) => Number.isFinite(l.min) && !seen.has(l.min) && (seen.add(l.min), true))
    .sort((a, b) => a.top - b.top);
  if (lanes.length < 2) { reset(); return; }
  const rowSize = lanes[1].min - lanes[0].min;

  for (let i = 0; i < lanes.length; i++) {
    const top = lanes[i].top;
    const bottom = i + 1 < lanes.length ? lanes[i + 1].top : top + (top - lanes[i - 1].top);
    if (ev.clientY >= top && ev.clientY < bottom) {
      // Fully-elapsed cells aren't interactable — no highlight, no actionable cursor.
      if (cellElapsed(col.date, lanes[i].min + rowSize)) { hoverTarget.value = null; root.style.cursor = 'default'; return; }
      root.style.cursor = 'pointer';
      // Only reassign when the cell actually changes — avoids a re-render on every pixel of movement.
      if (hoverTarget.value?.date === col.date && hoverTarget.value?.startMin === lanes[i].min) return;
      hoverTarget.value = { date: col.date, startMin: lanes[i].min, endMin: lanes[i].min + rowSize };
      return;
    }
  }
  reset();
}

function clearHover() {
  hoverTarget.value = null;
  const root = calendarRef.value?.getRootEl();
  if (root) root.style.cursor = '';
}

onMounted(() => {
  const root = calendarRef.value?.getRootEl();
  if (root) {
    root.addEventListener('pointermove', onGridPointerMove);
    root.addEventListener('pointerleave', clearHover);
  }
});

onBeforeUnmount(() => {
  const root = calendarRef.value?.getRootEl();
  if (root) {
    root.removeEventListener('pointermove', onGridPointerMove);
    root.removeEventListener('pointerleave', clearHover);
  }
});

// Duration-aware valid slots for the dragged appointment across the visible days (its own span freed).
async function loadHighlights(appt: Appointment) {
  dragDurationMinutes = appt.duration_minutes;
  const byDay = await loadSlotsByDay(appt.professional_user_id, appt.id);
  const targets = new Map<string, string[]>();
  for (const [date, slots] of byDay) {
    targets.set(date, computeValidStarts(slots, appt.duration_minutes));
  }
  highlightStartsByDay.value = targets;
}

const geometry = useTimegridGeometry(() => calendarRef.value?.getRootEl() ?? null);
const customDrag = useCustomDrag({
  geometry,
  fine: fineDrag,
  validStartsFor: (date) => (highlightStartsByDay.value.get(date) ?? []).map(toMinutes),
  onBegin: (appt) => { isDragging.value = true; hoverTarget.value = null; void loadHighlights(appt); },
  onEnd: () => { isDragging.value = false; highlightStartsByDay.value = new Map(); dragTarget.value = null; suppressEventClick = true; },
  onTarget: (date, minutes) => {
    dragTarget.value = date && minutes != null ? { date, minutes } : null;
  },
  onCommit: (appt, target) => { requestMove(appt, target, () => {}); },
});

const { calendarOptions } = useAppointmentCalendar(
  appointments,
  ref(auth.user),
  {
    onSelect: handleSelect,
    onEventClick: handleEventClick,
    onEventDrop: handleEventDrop,
    onEventResize: handleEventResize,
    onEventPointerDown: handleEventPointerDown,
  },
  { fallbackTitle: clientNameFor, tooltip: tooltipFor },
  { fine: fineDrag, slotStartsMinutes, slotMinutes },
);

// Resource availability overlay: green = free windows, grey hatch = closed/blocked (the complement
// within the visible working range). Timegrid only — background fills are meaningless in month view.
// No free windows on a day → the whole range reads as blocked, which is the "no availability" cue.
// The minute of today where "past" ends and "present" begins — the START of the cell containing now
// (now floored to the slot grid), NOT the exact minute. This keeps the current cell whole: it reads
// as present (striped if unavailable, white/booked if available) instead of being split flat/striped
// by a mid-cell boundary. Falls back to the exact minute when no grid is known (mixed 'Todos' view).
const todayShadeFloor = computed(() => {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const gran = slotMinutes.value;
  const starts = slotStartsMinutes.value;
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
const DAY_END_MINUTES = 24 * 60;

// A cell is fully elapsed (not bookable) if its whole day has passed, or — today — it ENDS at or
// before now. Compare the END, not the start, so the cell that currently contains "now" stays
// bookable even though it began a few minutes ago. (Background shading still greys up to now.)
function cellElapsed(date: string, endMin: number): boolean {
  const now = new Date();
  const today = dayISO(now, 0);
  if (date < today) return true;
  if (date === today) return endMin <= now.getHours() * 60 + now.getMinutes();
  return false;
}

const resourceBgEvents = computed<EventInput[]>(() => {
  if (filters.value.resource_id == null || !currentViewType.value.startsWith('timeGrid')) return [];
  const out: EventInput[] = [];
  for (const [date, slots] of resourceFreeByDay.value) {
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
  if (filters.value.resource_id != null) return [];
  if (filters.value.professional_user_id == null || !currentViewType.value.startsWith('timeGrid')) return [];
  const out: EventInput[] = [];
  for (const [date, slots] of professionalFreeByDay.value) {
    const floor = shadeFloorMinutes(date);
    if (floor == null) continue;
    for (const g of complementIntervals(slots, floor, DAY_END_MINUTES)) {
      out.push({ start: `${date}T${toHHMM(g.start)}:00`, end: `${date}T${toHHMM(g.end)}:00`, display: 'background', classNames: ['fc-res-closed'] });
    }
  }
  return out;
});

// Grey past time with a FLAT wash — distinct from the striped availability overlay. Past can't be
// booked, so it's de-emphasized rather than marked "closed": whole past days, and today up to the
// START of the current cell (same transition as the availability shading, so the current cell isn't
// split). Every timegrid view, independent of the professional/resource filter.
const pastBgEvents = computed<EventInput[]>(() => {
  if (!currentViewType.value.startsWith('timeGrid')) return [];
  const today = dayISO(new Date(), 0);
  const out: EventInput[] = [];
  let d = new Date(`${visibleRange.value.from}T00:00:00`);
  const end = new Date(`${visibleRange.value.to}T00:00:00`);
  while (d < end) {
    const date = dayISO(d, 0);
    const blockedEnd =
      date < today ? `${dayISO(d, 1)}T00:00:00`
      : date === today ? `${date}T${toHHMM(todayShadeFloor.value)}:00`
      : null;
    if (blockedEnd) {
      out.push({ start: `${date}T00:00:00`, end: blockedEnd, display: 'background', classNames: ['fc-slot-past'] });
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
});

// Must stay a computed (not a plain spread object) — FullCalendar's Vue wrapper only
// re-diffs options when the prop reference changes; a plain object built once at setup
// freezes `events` to whatever appointments held at that instant.
const fullOptions = computed<typeof calendarOptions.value>(() => {
  // Read here so the computed re-runs (and FC re-renders the graying) when the map is replaced.
  const monthAvail = monthAvailability.value;
  // Sobreturno mode makes full days bookable, so they must not read as disabled/greyed either.
  const fine = fineDrag.value;
  const baseViews: NonNullable<CalendarOptions['views']> = calendarOptions.value.views ?? {};
  return {
    ...calendarOptions.value,
    events: [
      ...((calendarOptions.value.events as EventInput[]) ?? []),
      ...pastBgEvents.value,
      ...resourceBgEvents.value,
      ...professionalBgEvents.value,
      ...hoverEvents.value,
      ...backgroundEvents.value,
      ...targetEvents.value,
    ],
    views: {
      ...baseViews,
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
      currentViewType.value = info.view.type;
      // FullCalendar re-fires datesSet on every re-render (e.g. a grid re-layout), not only on
      // navigation. Ignore same-range fires so they don't refetch or reset the hover-aligned grid.
      const from = info.startStr.slice(0, 10);
      const to = info.endStr.slice(0, 10);
      if (visibleRange.value.from === from && visibleRange.value.to === to) return;
      visibleRange.value = { from, to };
      void fetchAppointments();
    },
  };
});

function handleSelect(arg: DateSelectArg) {
  const day = arg.startStr.slice(0, 10);
  const hasTime = arg.startStr.length > 10;
  // Can't book in the past: a timegrid selection that has fully elapsed (ends at/before now), or any
  // day before today in month view. A selection covering the current moment stays allowed.
  const past = hasTime ? new Date(arg.endStr).getTime() <= Date.now() : day < dayISO(new Date(), 0);
  if (past) {
    toast.info('pastNotBookable');
    return;
  }
  // Month view: block days the professional has no availability on (matches the graying) —
  // unless sobreturno is on, which deliberately books outside published availability. A fully
  // booked day and a not-worked day get different messages.
  const dayStatus = monthAvailability.value.get(day);
  if (!fineDrag.value && currentViewType.value === 'dayGridMonth' && (dayStatus === 'full' || dayStatus === 'closed')) {
    toast.info(dayStatus === 'full' ? 'dayFullyBooked' : 'noSlotsThatDay');
    return;
  }
  formPrefillDate.value = day;
  formPrefillStart.value = arg.startStr.slice(11, 16) || undefined;
  formPrefillProfId.value = filters.value.professional_user_id ?? undefined;
  formPrefillResourceId.value = filters.value.resource_id ?? undefined;
  formAppt.value = undefined;
  formOpen.value = true;
}

function handleEventClick(arg: EventClickArg) {
  if (suppressEventClick) { suppressEventClick = false; return; }
  const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
  if (appt) {
    detailAppt.value = appt;
    detailOpen.value = true;
  }
}

// Timegrid events are moved by our own drag (useCustomDrag) so a sobreturno can snap onto real slots
// mid-drag. Resizer handles keep native resize; month-view events keep native (day-granularity) move.
function handleEventPointerDown(appt: Appointment, ev: PointerEvent, el: HTMLElement) {
  suppressEventClick = false;
  if (!auth.user || auth.user.role === 'Client') return;
  if ((ev.target as HTMLElement).closest('.fc-event-resizer')) return;
  if (!el.classList.contains('fc-timegrid-event')) return;
  customDrag.start(appt, ev, el);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

// Every move (custom timegrid drag, month drag, resize) funnels through here: confirm the resolved
// slot before persisting, or revert silently when it lands back on the block's own slot.
function requestMove(
  appt: Appointment,
  resolved: { date: string; start: string; duration_minutes?: number },
  revert: () => void,
) {
  // Same-day rule: a resize/move that would run past midnight (or yields a non-positive
  // duration) is rejected here with clear feedback — no confirm dialog, no backend round-trip.
  if (
    resolved.duration_minutes != null &&
    exceedsEndOfDay(toMinutes(resolved.start), resolved.duration_minutes)
  ) {
    toast.error('crossesMidnight');
    revert();
    return;
  }

  // A drag that snaps back to the block's own slot is a no-op — just revert, no dialog.
  const cur = new Date(appt.starts_at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const curDate = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
  const curStart = `${pad(cur.getHours())}:${pad(cur.getMinutes())}`;
  const sameDuration = resolved.duration_minutes == null || resolved.duration_minutes === appt.duration_minutes;
  if (resolved.date === curDate && resolved.start === curStart && sameDuration) {
    revert();
    return;
  }

  const when = `${formatDate(resolved.date)} ${resolved.start}`;
  const durationNote = resolved.duration_minutes ? ` (${resolved.duration_minutes} min)` : '';
  moveConfirmBody.value = `Mover el turno a ${when}${durationNote}?`;
  moveConfirmProceed.value = async () => {
    moveConfirmOpen.value = false;
    await doReschedule(appt.id, resolved, revert);
  };
  moveConfirmRevert.value = revert;
  moveConfirmOpen.value = true;
}

// Month-view native move only (timegrid move is the custom drag). A month drag changes the day and
// keeps the time-of-day; land it on a real slot unless sobreturno mode is on.
async function handleEventDrop(arg: EventDropArg) {
  const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
  if (!appt) { arg.revert(); return; }

  const date = arg.event.startStr.slice(0, 10);
  const dropped = arg.event.startStr.slice(11, 16);

  if (fineDrag.value) {
    requestMove(appt, { date, start: dropped }, arg.revert);
    return;
  }

  const slots = (await loadSlotsByDay(appt.professional_user_id, appt.id)).get(date) ?? [];
  const validStarts = computeValidStarts(slots, appt.duration_minutes).map(toMinutes);
  const resolved = validStarts.length ? resolveDrop(validStarts, toMinutes(dropped), Infinity) : null;
  const start = resolved !== null ? toHHMM(resolved) : dropped;

  requestMove(appt, { date, start }, arg.revert);
}

async function handleEventResize(arg: EventResizeDoneArg) {
  const appt = arg.event.extendedProps['appointment'] as Appointment | undefined;
  if (!appt) { arg.revert(); return; }

  const newStart = arg.event.startStr;
  const date = newStart.slice(0, 10);
  const start = newStart.slice(11, 16);
  // Derive duration from the real Date span, not an HH:MM subtraction: a resize to the day's end
  // reports its end as the next day's 00:00, which the string math would turn negative.
  const startD = arg.event.start;
  const endD = arg.event.end;
  const duration_minutes =
    startD && endD ? Math.round((endD.getTime() - startD.getTime()) / 60000) : appt.duration_minutes;

  requestMove(appt, { date, start, duration_minutes }, arg.revert);
}

function onMoveConfirm() {
  void moveConfirmProceed.value?.();
}

function onMoveCancel() {
  moveConfirmOpen.value = false;
  moveConfirmRevert.value?.();
  moveConfirmProceed.value = null;
  moveConfirmRevert.value = null;
}

async function doReschedule(
  id: number,
  body: { date?: string; start?: string; duration_minutes?: number },
  revertFn?: () => void,
  override = false,
) {
  const result = await rescheduleAppointment(id, { ...body, override });
  if (!result.ok) {
    toast.error('rescheduleFailed');
    revertFn?.();
    return;
  }
  const payload = result.data;
  if (!payload.saved) {
    // Warn first — open override dialog with revert callback.
    conflictVerdict.value = payload.verdict;
    conflictRevert.value = revertFn ?? null;
    conflictRetryFn.value = (ov: boolean) => doReschedule(id, body, revertFn, ov);
    conflictOpen.value = true;
  } else {
    await fetchAppointments();
  }
}

async function handleApproveRequest(appt: Appointment, override = false) {
  const result = await approveAppointment(appt.id, override);
  if (!result.ok) {
    toast.error('genericError');
    return;
  }
  const payload = result.data;
  if (!payload.saved) {
    conflictVerdict.value = payload.verdict;
    conflictRevert.value = null;
    conflictRetryFn.value = (ov: boolean) => handleApproveRequest(appt, ov);
    conflictOpen.value = true;
  } else {
    detailAppt.value = payload.appointment;
    await fetchAppointments();
  }
}

async function onOverrideConfirm() {
  conflictOpen.value = false;
  if (conflictRetryFn.value) {
    await conflictRetryFn.value(true);
  }
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
  conflictRevert.value = null;
}

function onOverrideCancel() {
  conflictOpen.value = false;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
  // revert is called inside ConflictOverrideDialog before emitting cancel.
  conflictRevert.value = null;
}

function onFormConflict(verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>) {
  conflictVerdict.value = verdict;
  conflictRevert.value = null;
  conflictRetryFn.value = retryFn;
  conflictOpen.value = true;
}

async function onDetailMutated(appt: Appointment) {
  detailAppt.value = appt;
  await fetchAppointments();
}

function onReschedule(appt: Appointment) {
  formAppt.value = appt;
  formPrefillDate.value = undefined;
  formPrefillStart.value = undefined;
  formPrefillProfId.value = undefined;
  formPrefillResourceId.value = undefined;
  formOpen.value = true;
  detailOpen.value = false;
}

async function onFormSaved(appt: Appointment) {
  formOpen.value = false;
  detailAppt.value = appt;
  detailOpen.value = true;
  await fetchAppointments();
}

function openNewForm() {
  formAppt.value = undefined;
  formPrefillDate.value = undefined;
  formPrefillStart.value = undefined;
  formPrefillProfId.value = filters.value.professional_user_id ?? undefined;
  formPrefillResourceId.value = filters.value.resource_id ?? undefined;
  formOpen.value = true;
}

function onFiltersUpdate(f: FilterState) {
  filters.value = f;
}
</script>

<template>
  <div class="flex flex-col gap-4 h-full">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">{{ t('nav.calendar') }}</h1>
      <AppButton variant="primary" @click="openNewForm">
        {{ t('calendar.newAppointment') }}
      </AppButton>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2">
      <CalendarFilters @update:filters="onFiltersUpdate" />

      <label v-if="canSobreturno" class="inline-flex items-center gap-2 text-sm font-medium cursor-pointer">
        <input v-model="fineDrag" type="checkbox" class="h-4 w-4 accent-accent" />
        {{ t('calendar.fineMode') }}
      </label>
    </div>

    <p class="text-xs text-neutral">
      {{ fineDrag ? t('calendar.dragHintFine') : t('calendar.dragHintSnap') }}
    </p>

    <div v-if="loading && appointments.length === 0" class="text-sm text-neutral">
      {{ t('loading') }}
    </div>
    <CalendarViewComponent ref="calendarRef" :options="fullOptions" />

    <AppointmentDetailPanel
      :appointment="detailAppt"
      :open="detailOpen"
      @close="detailOpen = false"
      @mutated="onDetailMutated"
      @reschedule="onReschedule"
      @approve="(appt) => handleApproveRequest(appt)"
    />

    <DetailPanel
      :open="formOpen"
      :title="formAppt ? t('calendar.reschedule') : t('calendar.newAppointment')"
      variant="side"
      @close="formOpen = false"
      @after-leave="formMounted = false"
    >
      <AppointmentForm
        v-if="formMounted"
        :appointment="formAppt"
        :prefill-date="formPrefillDate"
        :prefill-start="formPrefillStart"
        :prefill-professional-id="formPrefillProfId"
        :prefill-resource-id="formPrefillResourceId"
        @saved="onFormSaved"
        @conflict-detected="onFormConflict"
        @cancel="formOpen = false"
      />
    </DetailPanel>

    <ConfirmDialog
      :open="moveConfirmOpen"
      :title="t('calendar.reschedule')"
      :body="moveConfirmBody"
      :confirm-label="t('actions.confirm')"
      @confirm="onMoveConfirm"
      @cancel="onMoveCancel"
    />

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      :revert="conflictRevert"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />
  </div>
</template>
