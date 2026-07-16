<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DateSelectArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useCustomDrag } from '@/composables/useCustomDrag';
import { useTimegridGeometry } from '@/composables/useTimegridGeometry';
import { useGridInteraction } from '@/composables/useGridInteraction';
import type { SlotPick } from '@/composables/useGridInteraction';
import { useConflictOverride } from '@/composables/useConflictOverride';
import { useStateLabel } from '@/composables/useStateLabel';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { useScheduleExceptions } from '@/composables/useScheduleExceptions';
import { listAppointments, rescheduleAppointment, approveAppointment } from '@/api/appointments';
import { getAvailabilityRange } from '@/api/scheduling';
import { listClosures, type BusinessClosure } from '@/api/closures';
import type { Appointment } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { toMinutes, toHHMM } from '@shared/ssot/domain/availability';
import CalendarSurface from '@/components/calendar/CalendarSurface.vue';
import type { DayAvailability } from '@/components/calendar/CalendarSurface.vue';
import CalendarFilterBar from '@/components/calendar/CalendarFilterBar.vue';
import type { FilterState } from '@/components/calendar/CalendarFilters.vue';
import CalendarDialogs from '@/components/calendar/CalendarDialogs.vue';
import ExceptionList from '@/components/calendar/ExceptionList.vue';
import AppButton from '@/components/shared/AppButton.vue';
import { useCurrency } from '@/composables/useCurrency';
import { tileFreeWindows, resolveDrop, exceedsEndOfDay } from '@/composables/calendarGrid';
import { useProfessionalBlocks } from '@/composables/useProfessionalBlocks';
import { dayISO, bookedIntervalsByDate } from '@/composables/availabilityShading';
import type { BookedDay } from '@/composables/availabilityShading';

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToast();
const { formatDate } = useCurrency();

const appointments = ref<Appointment[]>([]);
const loading = ref(false);
let appointmentRequest = 0;


// Ref to the calendar surface — exposes the rendered root element the custom drag reads (via geometry).
const calendarRef = ref<InstanceType<typeof CalendarSurface> | null>(null);

const visibleRange = ref<{ from: string; to: string }>({
  from: dayISO(new Date(), 0),
  to: dayISO(new Date(), 7),
});

const filters = ref<FilterState>({ professional_user_id: null, resource_id: null });

// An exception always needs a single owner; the form has no picker of its own and reads
// filters — the mixed 'Todos' view (both null) can only fail server-side.
const canAddException = computed(() => filters.value.professional_user_id != null || filters.value.resource_id != null);

// Days-off / partial-block / extra-hours overlays for the selected owner.
const exceptions = useScheduleExceptions(filters, visibleRange);

// Business-wide closures (feriados) — owner-independent, so they render on every calendar regardless
// of the professional/resource filter. This is how staff (esp. an Admin on the mixed 'Todos' view)
// see a clinic holiday, which the per-owner exception overlay above never covers.
const businessClosures = ref<BusinessClosure[]>([]);
async function loadClosures() {
  const res = await listClosures();
  businessClosures.value = res.ok ? res.data : [];
}

// Free slots per visible day for a filtered resource; drives the availability shading overlay.
const resourceFreeByDay = ref<Map<string, { start: number; end: number }[]>>(new Map());
// Current FullCalendar view (from datesSet) — the resource overlay only makes sense in timegrid.
const currentViewType = ref('timeGridWeek');

const detailAppt = ref<Appointment | null>(null);
const detailOpen = ref(false);

const formOpen = ref(false);
const formAppt = ref<Appointment | undefined>(undefined);
const formPrefillDate = ref<string | undefined>();
const formPrefillStart = ref<string | undefined>();
const formPrefillProfId = ref<number | undefined>();
const formPrefillResourceId = ref<number | undefined>();
// Opened from a sobreturno (fine-mode) placement → the form starts in manual hora/duración mode,
// seeded with the nearest block's service duration.
const formPrefillSobreturno = ref(false);
const formPrefillDuration = ref<number | undefined>();


const { conflictOpen, conflictVerdict, conflictRevert, raiseConflict, onOverrideConfirm, onOverrideCancel } =
  useConflictOverride();

// Drag/resize is consequential — confirm the resolved slot before persisting.
const moveConfirmOpen = ref(false);
const moveConfirmBody = ref('');
const moveConfirmProceed = ref<(() => Promise<void>) | null>(null);
const moveConfirmRevert = ref<(() => void) | null>(null);

async function fetchAppointments() {
  const request = ++appointmentRequest;
  loading.value = true;
  const result = await listAppointments({
    date_from: visibleRange.value.from,
    date_to: visibleRange.value.to,
    professional_user_id: filters.value.professional_user_id ?? undefined,
    resource_id: filters.value.resource_id ?? undefined,
    limit: 200,
  });
  if (request !== appointmentRequest) return;
  loading.value = false;
  if (result.ok) {
    appointments.value = result.data as Appointment[];
    // Bookings changed → the visible professional's slot lattice (visual row sizing) is stale.
    void refreshSnapGrid();
    // …and a filtered resource's free/blocked shading depends on the same bookings.
    void loadResourceAvailability();
    // …and the month-view per-day availability (graying + click-to-book gating).
    void loadMonthAvailability();
    // …and the business-wide closure bands (a feriado added elsewhere must surface here).
    void loadClosures();
  }
}

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
const { stateLabel } = useStateLabel();
function tooltipFor(appt: Appointment): string {
  return [
    clientLabelFor(appt.client_user_id),
    professionalLabelFor(appt.professional_user_id),
    serviceLabelFor(appt.service_id),
    stateLabel(appt.state),
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

// Duration-aware valid drop targets for the appointment currently being dragged, keyed by day.
// Populated on drag start (excluding the dragged appointment), cleared on drag stop.
const highlightStartsByDay = ref<Map<string, string[]>>(new Map());
const dragDurationMinutes = ref(0);

// Fetch a professional's free slots for each visible day, all days in parallel so a hover pulls
// the week in ~one round-trip. `exclude` frees the dragged block's own span so it can be nudged
// near its current position.
async function loadSlotsByDay(profId: string | number, exclude?: string): Promise<Map<string, { start: string; end: string }[]>> {
  const result = await getAvailabilityRange(`prof:${profId}`, visibleRange.value.from, visibleRange.value.to, exclude);
  const byDay = new Map<string, { start: string; end: string }[]>();
  if (result.ok) result.data.forEach((day) => byDay.set(day.date, day.slots));
  return byDay;
}

// The selected professional's working blocks (weekday + minute range + per-block slot size), for
// the permanent slot outline overlay.
const { blocks: professionalBlocks } = useProfessionalBlocks(() => filters.value.professional_user_id);

const isDragging = ref(false);
const geometry = useTimegridGeometry(() => calendarRef.value?.getRootEl() ?? null);

// Pointer→slot resolution, snap lattice, hover highlights, and click-to-book for the timegrid.
const {
  slotStartsMinutes,
  slotMinutes,
  professionalFreeByDay,
  refreshSnapGrid,
  slotBookableByAvailability,
  hoverTarget,
  hoverEvents,
  hoverPreviewEvents,
  suppressNextGridClick,
} = useGridInteraction({
  getRoot: () => calendarRef.value?.getRootEl() ?? null,
  geometry,
  fineDrag,
  isDragging,
  currentViewType,
  professionalId: () => filters.value.professional_user_id,
  blocks: professionalBlocks,
  loadSlotsByDay,
  cellElapsed,
  onSlotPicked,
  onPastPick: () => toast.info('pastNotBookable'),
});

watch(filters, fetchAppointments, { immediate: true, deep: true });
watch(() => filters.value.professional_user_id, refreshSnapGrid);
watch(visibleRange, refreshSnapGrid, { deep: true });

// Occupied vs requested minute-intervals per date for the selected professional. Drives the
// background shading, the "no dotted outline on a taken slot", and the "no hover on a taken slot"
// rules — one source so they never disagree.
const bookedByDate = computed<Map<string, BookedDay>>(() => {
  const profId = filters.value.professional_user_id;
  if (profId == null) return new Map();
  return bookedIntervalsByDate(
    appointments.value.filter((a) => a.professional_user_id === String(profId)),
  );
});

async function loadResourceAvailability() {
  const resId = filters.value.resource_id;
  if (resId == null) { resourceFreeByDay.value = new Map(); return; }
  const result = await getAvailabilityRange(`res:${resId}`, visibleRange.value.from, visibleRange.value.to);
  const byDay = new Map<string, { start: number; end: number }[]>();
  if (result.ok) result.data.forEach((day) => {
    byDay.set(day.date, day.slots.map((slot) => ({ start: toMinutes(slot.start), end: toMinutes(slot.end) })));
  });
  resourceFreeByDay.value = byDay;
}

// Per-day availability for the visible month grid, only when a single professional is in view.
// Drives the "no availability" graying and gates click-to-book on empty days.
const monthAvailability = ref<Map<string, DayAvailability>>(new Map());

async function loadMonthAvailability() {
  const profId = filters.value.professional_user_id;
  if (currentViewType.value !== 'dayGridMonth' || profId == null) {
    if (monthAvailability.value.size) monthAvailability.value = new Map();
    return;
  }
  const result = await getAvailabilityRange(`prof:${profId}`, visibleRange.value.from, visibleRange.value.to);
  const map = new Map<string, DayAvailability>();
  if (result.ok) result.data.forEach((day) => {
    map.set(day.date, day.slots.length > 0 ? 'free' : day.open ? 'full' : 'closed');
  });
  monthAvailability.value = map;
}

// The slot the drag is currently over, highlighted brighter than the open-slot boxes.
const dragOrigin = ref<{ date: string; minutes: number; duration: number } | null>(null);
let dragTargetOverlay: HTMLElement | null = null;
let draggedAppointment: Appointment | null = null;
const DRAG_LAYOUT_PREVIEW_ID = '__drag-layout-preview';
const dragLayoutPreviewEvents = ref<EventInput[]>([]);
let layoutPreviewKey = '';
let layoutPreviewFrame: number | null = null;

function removeLayoutPreview() {
  if (layoutPreviewFrame != null) cancelAnimationFrame(layoutPreviewFrame);
  layoutPreviewFrame = null;
  layoutPreviewKey = '';
  dragLayoutPreviewEvents.value = [];
}

function conflictKey(date: string, minutes: number): string {
  const dragged = draggedAppointment;
  if (!dragged) return '';
  const end = minutes + dragged.duration_minutes;
  return appointments.value
    .filter((appointment) => {
      if (appointment.id === dragged.id) return false;
      if (String(appointment.professional_user_id) !== String(dragged.professional_user_id)) return false;
      const start = new Date(appointment.starts_at);
      const appointmentStart = start.getHours() * 60 + start.getMinutes();
      return dayISO(start, 0) === date
        && minutes < appointmentStart + appointment.duration_minutes
        && appointmentStart < end;
    })
    .map((appointment) => String(appointment.id))
    .sort()
    .join(',');
}

function syncLayoutPreview(date: string, minutes: number, magnetized: boolean) {
  const dragged = draggedAppointment;
  if (!dragged) return;
  const conflicts = conflictKey(date, minutes);
  const key = magnetized ? `${date}:${minutes}:${conflicts}` : `${date}:${conflicts}`;
  if (key === layoutPreviewKey) return;
  layoutPreviewKey = key;
  const start = `${date}T${toHHMM(minutes)}:00`;
  const end = `${date}T${toHHMM(minutes + dragged.duration_minutes)}:00`;
  dragLayoutPreviewEvents.value = [{
    id: DRAG_LAYOUT_PREVIEW_ID,
    start,
    end,
    display: 'block',
    classNames: ['fc-drag-layout-preview'],
  }];

  if (layoutPreviewFrame != null) cancelAnimationFrame(layoutPreviewFrame);
  const alignGhostToPreview = (attemptsLeft: number) => {
    layoutPreviewFrame = null;
    const root = calendarRef.value?.getRootEl();
    const previewElement = root?.querySelector<HTMLElement>('.fc-drag-layout-preview');
    const ghost = root?.querySelector<HTMLElement>('.fc-drag-ghost');
    if (!previewElement || !ghost) {
      if (attemptsLeft > 0) layoutPreviewFrame = requestAnimationFrame(() => alignGhostToPreview(attemptsLeft - 1));
      return;
    }
    const rect = previewElement.getBoundingClientRect();
    ghost.style.left = `${rect.left}px`;
    ghost.style.width = `${rect.width}px`;
    if (dragTargetOverlay) {
      dragTargetOverlay.style.left = `${rect.left}px`;
      dragTargetOverlay.style.width = `${rect.width}px`;
    }
  };
  layoutPreviewFrame = requestAnimationFrame(() => alignGhostToPreview(2));
}

function clearDragTargetOverlay() {
  dragTargetOverlay?.remove();
  dragTargetOverlay = null;
  removeLayoutPreview();
}

function renderDragTargetOverlay(date: string | null, minutes: number | null, elapsed = false, magnetized = false) {
  if (!date || minutes == null) { clearDragTargetOverlay(); return; }
  const root = calendarRef.value?.getRootEl();
  const column = geometry.columns().find((candidate) => candidate.date === date);
  const top = geometry.yForMinutes(minutes);
  const pxPerMinute = geometry.pxPerMinute();
  if (!root || !column || top == null || pxPerMinute == null) { clearDragTargetOverlay(); return; }
  const overlay = dragTargetOverlay ?? document.createElement('div');
  if (!dragTargetOverlay) {
    Object.assign(overlay.style, { position: 'fixed', margin: '0', pointerEvents: 'none', zIndex: '4' });
    root.appendChild(overlay);
    dragTargetOverlay = overlay;
  }
  overlay.className = `fc-slot-target fc-drag-target-overlay${elapsed ? ' fc-drag-target-invalid' : ''}`;
  const ghostRect = root.querySelector<HTMLElement>('.fc-drag-ghost')?.getBoundingClientRect();
  Object.assign(overlay.style, {
    top: `${ghostRect?.top ?? top}px`,
    left: `${ghostRect?.left ?? column.left + 2}px`,
    width: `${ghostRect?.width ?? column.width - 4}px`,
    height: `${ghostRect?.height ?? dragDurationMinutes.value * pxPerMinute}px`,
  });
  syncLayoutPreview(date, minutes, magnetized);
}

// A completed drag emits a trailing click; swallow it once so it doesn't also open the detail panel.
// Cleared on the next event press, so it can never suppress an unrelated later click.
let suppressEventClick = false;

// Slot clicked/placed on the grid → the new-appointment form prefilled with that slot
// (date, start, owner, sobreturno seed).
function onSlotPicked(pick: SlotPick) {
  formPrefillDate.value = pick.date;
  formPrefillStart.value = toHHMM(pick.startMin);
  formPrefillProfId.value = filters.value.professional_user_id ?? undefined;
  formPrefillResourceId.value = filters.value.resource_id ?? undefined;
  formPrefillSobreturno.value = pick.sobreturno;
  formPrefillDuration.value = pick.durationMinutes;
  formAppt.value = undefined;
  formOpen.value = true;
}

// Whether loadHighlights has finished for the in-flight drag. Until then an empty valid-starts list
// means "still loading", not "no free slot" — the coarse no-free-slot freeze must wait for this.
const highlightsReady = ref(false);

// Duration-aware valid slots for the dragged appointment across the visible days (its own span freed).
async function loadHighlights(appt: Appointment) {
  highlightsReady.value = false;
  dragDurationMinutes.value = appt.duration_minutes;
  const byDay = await loadSlotsByDay(appt.professional_user_id, appt.id);
  const targets = new Map<string, string[]>();
  const origin = new Date(appt.starts_at);
  const originDate = dayISO(origin, 0);
  const originMinutes = origin.getHours() * 60 + origin.getMinutes();
  for (const [date, slots] of byDay) {
    targets.set(date, tileFreeWindows(slots, appt.duration_minutes).filter(
      (start) => {
        const minutes = toMinutes(start);
        return !(date === originDate && minutes === originMinutes)
          && !cellElapsed(date, minutes + appt.duration_minutes);
      },
    ));
  }
  highlightStartsByDay.value = targets;
  highlightsReady.value = true;
}

const customDrag = useCustomDrag({
  geometry,
  fine: fineDrag,
  ghostParent: () => calendarRef.value?.getRootEl() ?? null,
  validStartsFor: (date) => (highlightStartsByDay.value.get(date) ?? []).map(toMinutes),
  ready: () => highlightsReady.value,
  targetElapsed: (date, start, duration) => cellElapsed(date, start + duration),
  onBegin: (appt) => {
    const origin = new Date(appt.starts_at);
    dragOrigin.value = {
      date: dayISO(origin, 0),
      minutes: origin.getHours() * 60 + origin.getMinutes(),
      duration: appt.duration_minutes,
    };
    draggedAppointment = appt;
    isDragging.value = true;
    hoverTarget.value = null;
    void loadHighlights(appt);
  },
  onEnd: () => { isDragging.value = false; highlightStartsByDay.value = new Map(); clearDragTargetOverlay(); draggedAppointment = null; dragOrigin.value = null; suppressEventClick = true; suppressNextGridClick(); },
  onTarget: renderDragTargetOverlay,
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
);

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

function onDatesSet(info: { startStr: string; endStr: string; view: { type: string } }) {
  currentViewType.value = info.view.type;
  // FullCalendar re-fires datesSet on every re-render (e.g. a grid re-layout), not only on
  // navigation. Ignore same-range fires so they don't refetch or reset the hover-aligned grid.
  const from = info.startStr.slice(0, 10);
  const to = info.endStr.slice(0, 10);
  if (visibleRange.value.from === from && visibleRange.value.to === to) return;
  visibleRange.value = { from, to };
  void fetchAppointments();
}

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
  formPrefillSobreturno.value = fineDrag.value;
  formPrefillDuration.value = undefined;
  formAppt.value = undefined;
  formOpen.value = true;
  // A drag-select ends with a trailing click on the grid — don't let it re-open the form.
  suppressNextGridClick();
}

function handleEventClick(arg: EventClickArg) {
  if (suppressEventClick) { suppressEventClick = false; return; }
  // Sobreturno mode: a plain click places a new overlapping turno (grid click), not the detail panel.
  if (fineDrag.value) return;
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
  moveConfirmBody.value = t('calendar.moveConfirm', { when: `${when}${durationNote}` });
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
  const validStarts = tileFreeWindows(slots, appt.duration_minutes).map(toMinutes);
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
  id: string,
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
    raiseConflict(payload.verdict, (ov: boolean) => doReschedule(id, body, revertFn, ov), revertFn);
  } else {
    appointments.value = appointments.value.map((appointment) => (
      appointment.id === payload.appointment.id ? payload.appointment : appointment
    ));
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
    raiseConflict(payload.verdict, (ov: boolean) => handleApproveRequest(appt, ov));
  } else {
    detailAppt.value = payload.appointment;
    await fetchAppointments();
  }
}

function onFormConflict(verdict: ConflictVerdict, retryFn: (override: boolean) => Promise<void>) {
  raiseConflict(verdict, retryFn);
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
  formPrefillSobreturno.value = false;
  formPrefillDuration.value = undefined;
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
  formPrefillSobreturno.value = false;
  formPrefillDuration.value = undefined;
  formOpen.value = true;
}

async function onExceptionDeleted() {
  await exceptions.reload();
  await fetchAppointments();
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

    <CalendarFilterBar
      v-model:fine-drag="fineDrag"
      :can-sobreturno="canSobreturno"
      @update:filters="onFiltersUpdate"
    />

    <div v-if="loading && appointments.length === 0" class="text-sm text-neutral">
      {{ t('loading') }}
    </div>
    <CalendarSurface
      ref="calendarRef"
      :base-options="calendarOptions"
      :fine-drag="fineDrag"
      :current-view-type="currentViewType"
      :visible-range="visibleRange"
      :professional-id="filters.professional_user_id"
      :resource-id="filters.resource_id"
      :professional-blocks="professionalBlocks"
      :business-closures="businessClosures"
      :month-availability="monthAvailability"
      :resource-free-by-day="resourceFreeByDay"
      :professional-free-by-day="professionalFreeByDay"
      :booked-by-date="bookedByDate"
      :highlight-starts-by-day="highlightStartsByDay"
      :drag-origin="dragOrigin"
      :drag-duration-minutes="dragDurationMinutes"
      :slot-minutes="slotMinutes"
      :slot-starts-minutes="slotStartsMinutes"
      :exception-bg-events="exceptions.bgEvents.value"
      :hover-events="hoverEvents"
      :hover-preview-events="hoverPreviewEvents"
      :drag-layout-preview-events="dragLayoutPreviewEvents"
      :cell-elapsed="cellElapsed"
      :slot-bookable-by-availability="slotBookableByAvailability"
      @dates-set="onDatesSet"
    />

    <ExceptionList v-if="canAddException" :rows="exceptions.rows.value" @deleted="onExceptionDeleted" />

    <CalendarDialogs
      :detail-appointment="detailAppt"
      :detail-open="detailOpen"
      :form-open="formOpen"
      :form-appointment="formAppt"
      :prefill-date="formPrefillDate"
      :prefill-start="formPrefillStart"
      :prefill-professional-id="formPrefillProfId"
      :prefill-resource-id="formPrefillResourceId"
      :prefill-sobreturno="formPrefillSobreturno"
      :prefill-duration="formPrefillDuration"
      :move-confirm-open="moveConfirmOpen"
      :move-confirm-body="moveConfirmBody"
      :conflict-open="conflictOpen"
      :conflict-verdict="conflictVerdict"
      :conflict-revert="conflictRevert"
      @detail-close="detailOpen = false"
      @detail-mutated="onDetailMutated"
      @reschedule="onReschedule"
      @approve="(appt) => handleApproveRequest(appt)"
      @form-close="formOpen = false"
      @form-saved="onFormSaved"
      @form-conflict="onFormConflict"
      @move-confirm="onMoveConfirm"
      @move-cancel="onMoveCancel"
      @override-confirm="onOverrideConfirm"
      @override-cancel="onOverrideCancel"
    />
  </div>
</template>
