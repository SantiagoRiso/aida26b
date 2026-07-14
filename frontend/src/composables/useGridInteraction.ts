import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import type { Ref } from 'vue';
import type { EventInput } from '@fullcalendar/core';
import { WEEKDAYS } from '@shared/ssot/domain';
import { toMinutes, toHHMM } from '@shared/ssot/domain/availability';
import { latticeFromFreeSlots } from '@/composables/calendarGrid';
import { i18n } from '@/i18n';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import type { ProfessionalBlock } from '@/composables/useProfessionalBlocks';

// The custom drag itself (useCustomDrag) stays separate from this — this only owns the grid side.

// Sobreturno free-click step: a placement snaps to this (matching the sobreturno drag's 5-min snap).
const FREE_SNAP_MINUTES = 5;
// Free placement reads the cursor as this many px higher, so the ghost's top (the start line) tracks
// the pointer rather than hanging below it. Applied identically to hover and click so they agree.
const SOBRETURNO_GHOST_OFFSET_PX = 15;

export interface SlotPick {
  date: string;
  startMin: number;
  sobreturno: boolean;
  durationMinutes?: number;
}

export interface GridInteractionOptions {
  getRoot: () => HTMLElement | null;
  geometry: TimegridGeometry;
  fineDrag: Ref<boolean>;
  isDragging: Ref<boolean>;
  currentViewType: Ref<string>;
  professionalId: () => number | null;
  blocks: Ref<ProfessionalBlock[]>;
  loadSlotsByDay: (profId: string | number) => Promise<Map<string, { start: string; end: string }[]>>;
  cellElapsed: (date: string, endMin: number) => boolean;
  onSlotPicked: (pick: SlotPick) => void;
  onPastPick: () => void;
}

export function useGridInteraction(opts: GridInteractionOptions) {
  const { getRoot, geometry, fineDrag, isDragging, currentViewType, professionalId, blocks, cellElapsed } = opts;

  // Selected professional's real slot starts (minutes from midnight) across the visible days, plus
  // their granularity — drives the live snap grid. Null when no single professional is selected.
  const slotStartsMinutes = ref<number[] | null>(null);
  const slotMinutes = ref<number | null>(null);

  // A professional's snap lattice from their free slots: real slot starts plus the finest slot
  // length. Null when they have no slots in view.
  function applyGrid(grid: { starts: number[] | null; minutes: number | null }) {
    slotStartsMinutes.value = grid.starts;
    slotMinutes.value = grid.minutes;
  }

  // Free intervals (minutes) per visible day for the selected professional — drives the availability
  // overlay (grey = closed / unavailable) in the week/day grid.
  const professionalFreeByDay = ref<Map<string, { start: number; end: number }[]>>(new Map());

  // A representative slot length for the professional (their first block's), used only for the
  // free-placement hover box in sobreturno mode. 30 min when unknown.
  function proSlotMinutes(): number {
    return blocks.value[0]?.slotMinutes ?? 30;
  }

  // Size the visible grid rows to a selected professional's slot lattice AND capture their free time
  // for the unavailable-shading overlay. The mixed 'Todos' view has no single professional → both empty.
  async function refreshSnapGrid() {
    const profId = professionalId();
    if (profId == null) {
      applyGrid({ starts: null, minutes: null });
      professionalFreeByDay.value = new Map();
      return;
    }
    const byDay = await opts.loadSlotsByDay(profId);
    // Drag-box / shading step = the professional's schedule slot size (never the free-slot lengths — a
    // small booking gap would collapse it, and an empty week would explode it). Schedule-derived, so it
    // is stable whether or not the week has bookings. 30 min when unknown.
    const lattice = latticeFromFreeSlots([...byDay.values()].flat());
    applyGrid({ starts: lattice.starts, minutes: proSlotMinutes() });
    const map = new Map<string, { start: number; end: number }[]>();
    for (const [date, slots] of byDay) {
      map.set(date, slots.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) })));
    }
    professionalFreeByDay.value = map;
  }

  // The schedule slot (start/end minutes) covering `minute` on `date`, or null when the point is outside
  // every working block (a gap / off-hours). Tiles each block by its own slot size, dropping a trailing partial.
  function slotAt(date: string, minute: number): { startMin: number; endMin: number } | null {
    if (professionalId() == null) return null;
    const wk = WEEKDAYS[new Date(`${date}T00:00:00`).getDay()];
    for (const b of blocks.value) {
      if (b.weekday !== wk || minute < b.start || minute >= b.end) continue;
      const start = b.start + Math.floor((minute - b.start) / b.slotMinutes) * b.slotMinutes;
      if (start + b.slotMinutes <= b.end) return { startMin: start, endMin: start + b.slotMinutes };
    }
    return null;
  }

  // The slot size of the block nearest (in time) to `minute` on `date` — the service duration to seed a
  // sobreturno placed there. Falls back to the professional's representative slot when they don't work
  // that weekday.
  function nearestBlockSlotMinutes(date: string, minute: number): number {
    const wk = WEEKDAYS[new Date(`${date}T00:00:00`).getDay()];
    const onDay = blocks.value.filter((b) => b.weekday === wk);
    if (!onDay.length) return proSlotMinutes();
    let best = onDay[0];
    let bestDist = Infinity;
    for (const b of onDay) {
      const dist = minute < b.start ? b.start - minute : minute > b.end ? minute - b.end : 0;
      if (dist < bestDist) { bestDist = dist; best = b; }
    }
    return best.slotMinutes;
  }

  // A weekly block slot is actually bookable only when the day's availability still contains it.
  // schedule_blocks alone don't know about a licencia/feriado (personal or business-wide) or existing
  // bookings; the availability free windows (blocks − time-off − booked) do. Gating the dotted grid and
  // the click/hover resolution on this stops a holiday from still advertising — and accepting — slots.
  function slotBookableByAvailability(date: string, startMin: number, endMin: number): boolean {
    const windows = professionalFreeByDay.value.get(date);
    if (!windows) return false;
    return windows.some((w) => w.start <= startMin && endMin <= w.end);
  }

  // The slot a pointer at (date, minute) resolves to for hover/click. Grid mode: the schedule slot
  // covering the point, or null outside every working block (nothing to book there). Sobreturno mode:
  // a freely-placed slot snapped to FREE_SNAP_MINUTES — the schedule grid is bypassed so staff can book
  // off the lattice. The caller decides what a past (elapsed) slot means.
  function resolveGridSlot(date: string, minute: number): { startMin: number; endMin: number } | null {
    if (fineDrag.value) {
      // Floor (not round) so the slot starts at or just above the cursor — never a step below it.
      const startMin = Math.max(0, Math.floor(minute / FREE_SNAP_MINUTES) * FREE_SNAP_MINUTES);
      return { startMin, endMin: startMin + proSlotMinutes() };
    }
    return slotAt(date, Math.floor(minute));
  }

  // Per-cell hover highlight for the timegrid (mirrors the month view's per-day-cell hover). Suppressed
  // while dragging so it doesn't compete with the drag target.
  const hoverTarget = ref<{ date: string; startMin: number; endMin: number } | null>(null);

  // A completed drag/drag-select emits a trailing click; swallow it once so it doesn't also open the
  // new-appointment form. Cleared on the next grid click.
  let suppressGridClick = false;
  function suppressNextGridClick() {
    suppressGridClick = true;
  }

  // The single slot cell the cursor is over (week/day view) — a discrete background highlight like the
  // month grid. Grid mode only; sobreturno mode previews as a real (foreground) event instead.
  const hoverEvents = computed<EventInput[]>(() => {
    if (!hoverTarget.value || fineDrag.value) return [];
    const { date, startMin, endMin } = hoverTarget.value;
    return [{
      start: `${date}T${toHHMM(startMin)}:00`,
      end: `${date}T${toHHMM(endMin)}:00`,
      display: 'background',
      classNames: ['fc-slot-hover'],
    }];
  });

  // Sobreturno hover: a foreground preview block at the hovered position. Being a real event, it joins
  // FullCalendar's side-by-side layout (slotEventOverlap:false), so any turnos it overlaps are shoved
  // aside — previewing how the sobreturno would render. No appointment prop, so a click still falls
  // through to onGridClick (opening the form) rather than a detail panel.
  const hoverPreviewEvents = computed<EventInput[]>(() => {
    if (!fineDrag.value || !hoverTarget.value) return [];
    const { date, startMin, endMin } = hoverTarget.value;
    return [{
      title: i18n.global.t('calendar.fineMode'),
      start: `${date}T${toHHMM(startMin)}:00`,
      end: `${date}T${toHHMM(endMin)}:00`,
      classNames: ['fc-sobreturno-preview'],
    }];
  });

  // Highlight the slot under the cursor: the real schedule slot (grid mode) or a free-placed slot
  // (sobreturno). Nothing to book (grid gap) or a fully-elapsed slot → no highlight, default cursor.
  function onGridPointerMove(ev: PointerEvent) {
    const root = getRoot();
    const reset = () => { hoverTarget.value = null; if (root) root.style.cursor = ''; };
    if (isDragging.value || !currentViewType.value.startsWith('timeGrid')) { reset(); return; }
    if (!root) { hoverTarget.value = null; return; }
    // The toolbar and day headers sit inside the calendar root too — only the scrollable slot body maps
    // to a bookable time, so ignore anything outside it (otherwise sobreturno hover fires on the header).
    if (!(ev.target as HTMLElement).closest('.fc-timegrid-body')) { reset(); return; }
    const col = geometry.columnAt(ev.clientX);
    const minute = col ? geometry.minutesAt(ev.clientY - (fineDrag.value ? SOBRETURNO_GHOST_OFFSET_PX : 0)) : null;
    if (!col || minute === null) { reset(); return; }

    const slot = resolveGridSlot(col.date, minute);
    if (!slot || cellElapsed(col.date, slot.endMin)) { reset(); return; }
    // Grid mode only offers slots the day's availability still has (excludes booked AND time-off); a
    // sobreturno may deliberately overlap, so only gate when not in fine mode.
    if (!fineDrag.value && !slotBookableByAvailability(col.date, slot.startMin, slot.endMin)) { reset(); return; }
    root.style.cursor = 'pointer';
    // Only reassign when the slot actually changes — avoids a re-render on every pixel of movement.
    if (hoverTarget.value?.date === col.date && hoverTarget.value?.startMin === slot.startMin) return;
    hoverTarget.value = { date: col.date, startMin: slot.startMin, endMin: slot.endMin };
  }

  // Click a slot → hand the resolved slot to the host (which opens the new-appointment form). Grid
  // mode: only inside a real slot. Sobreturno mode: anywhere, snapped freely. A past slot can't be
  // booked — the host warns (mirrors the drag-select / month past guard). Clicks on an existing
  // appointment fall through to eventClick (its detail panel).
  function onGridClick(ev: MouseEvent) {
    if (isDragging.value || suppressGridClick) { suppressGridClick = false; return; }
    if (!currentViewType.value.startsWith('timeGrid')) return;
    // The toolbar (prev/next/today/view) and day headers sit inside the calendar root too — only the
    // slot body books, so a nav click never places a turno.
    if (!(ev.target as HTMLElement).closest('.fc-timegrid-body')) return;
    // A click on an existing turno normally opens its detail (eventClick). In sobreturno mode it instead
    // places a new overlapping turno there, so don't defer to the event.
    if (!fineDrag.value && (ev.target as HTMLElement).closest('.fc-timegrid-event')) return;
    const col = geometry.columnAt(ev.clientX);
    const minute = col ? geometry.minutesAt(ev.clientY - (fineDrag.value ? SOBRETURNO_GHOST_OFFSET_PX : 0)) : null;
    if (!col || minute === null) return;
    const slot = resolveGridSlot(col.date, minute);
    if (!slot) return;
    if (!fineDrag.value && !slotBookableByAvailability(col.date, slot.startMin, slot.endMin)) return;
    if (cellElapsed(col.date, slot.endMin)) { opts.onPastPick(); return; }
    opts.onSlotPicked({
      date: col.date,
      startMin: slot.startMin,
      sobreturno: fineDrag.value,
      durationMinutes: fineDrag.value ? nearestBlockSlotMinutes(col.date, slot.startMin) : undefined,
    });
  }

  function clearHover() {
    hoverTarget.value = null;
    const root = getRoot();
    if (root) root.style.cursor = '';
  }

  onMounted(() => {
    const root = getRoot();
    if (root) {
      root.addEventListener('pointermove', onGridPointerMove);
      root.addEventListener('pointerleave', clearHover);
      root.addEventListener('click', onGridClick);
    }
  });

  onBeforeUnmount(() => {
    const root = getRoot();
    if (root) {
      root.removeEventListener('pointermove', onGridPointerMove);
      root.removeEventListener('pointerleave', clearHover);
      root.removeEventListener('click', onGridClick);
    }
  });

  return {
    slotStartsMinutes,
    slotMinutes,
    professionalFreeByDay,
    refreshSnapGrid,
    slotBookableByAvailability,
    hoverTarget,
    hoverEvents,
    hoverPreviewEvents,
    suppressNextGridClick,
  };
}
