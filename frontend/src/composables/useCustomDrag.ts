import type { Ref } from 'vue';
import type { Appointment } from '@/api/appointments';
import { snapDragMinutes } from '@/composables/calendarGrid';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import { createDragGhost, type DragGhost } from '@/composables/dragGhost';
import { isoDate } from '@/composables/bookingForm';

// A drag we drive ourselves instead of FullCalendar's. FC moves an event by a snapped delta from its
// original start, so a block that begins off the lattice (a sobreturno) can never step onto real slots
// mid-drag. Owning the drag lets us snap the block's absolute position to the professional's slots on
// every pointer move — coarse lands on real slots, sobreturno mode places freely at 5 min. Native FC
// event-move is disabled (eventStartEditable:false); resize stays native.

const DRAG_THRESHOLD_PX = 4;

export interface CustomDragDeps {
  geometry: TimegridGeometry;
  fine: Ref<boolean>;
  // Where the ghost is appended — the calendar root, so it inherits the event's scoped CSS 1:1. Falls
  // back to <body> when absent.
  ghostParent?: () => HTMLElement | null;
  // Valid slot starts (minutes-of-day) for a day, for coarse snapping. Empty when unknown or none.
  validStartsFor: (date: string) => number[];
  // Whether availability for this drag has finished loading. Until then, an empty validStartsFor means
  // "not loaded yet" rather than "no free slot", so the coarse no-free-slot freeze must wait for this.
  ready: () => boolean;
  // Past targets remain visible under the pointer but can never be committed.
  targetElapsed: (date: string, startMinutes: number, durationMinutes: number) => boolean;
  // A real drag started (threshold crossed) — the view loads slots and shows highlights.
  onBegin: (appt: Appointment) => void;
  // Drag ended (commit or abort) — the view clears highlights and the live target.
  onEnd: () => void;
  // Live snapped target changed, for a highlight box. Null date when the pointer is off the grid.
  onTarget: (date: string | null, minutes: number | null, elapsed?: boolean, magnetized?: boolean) => void;
  // Commit the move — the view confirms and persists.
  onCommit: (appt: Appointment, target: { date: string; start: string }) => void;
}

interface Session {
  appt: Appointment;
  el: HTMLElement;
  downX: number;
  downY: number;
  grabOffsetPx: number; // pointer Y minus the block's top edge at press
  heightPx: number;
  dragging: boolean;
  ghost: DragGhost | null;
  lastLeft: number;
  lastWidth: number;
  lastDate: string;
  lastStart: number; // snapped minutes-of-day
  validTarget: boolean; // whether the current position is a droppable spot (false = over a booked/off day in coarse mode)
  cancelTarget: boolean;
  elapsedTarget: boolean;
  originalDate: string;
  originalStart: number;
}

const MAGNET_THRESHOLD_MINUTES = 20;

function hhmm(minutes: number): string {
  const clamped = Math.max(0, minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

export function useCustomDrag(deps: CustomDragDeps): {
  start: (appt: Appointment, ev: PointerEvent, el: HTMLElement) => void;
} {
  let session: Session | null = null;
  let moveFrame: number | null = null;
  let pendingMove: PointerEvent | null = null;

  function flushMove() {
    moveFrame = null;
    const ev = pendingMove;
    pendingMove = null;
    if (ev) position(ev);
  }

  function scheduleMove(ev: PointerEvent) {
    pendingMove = ev;
    if (moveFrame == null) moveFrame = requestAnimationFrame(flushMove);
  }

  function cleanup() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    if (moveFrame != null) cancelAnimationFrame(moveFrame);
    moveFrame = null;
    pendingMove = null;
    deps.geometry.endInteraction?.();
    session?.ghost?.destroy();
    session = null;
  }

  function begin(ev: PointerEvent) {
    if (!session) return;
    const rect = session.el.getBoundingClientRect();
    session.heightPx = rect.height;
    session.lastLeft = rect.left;
    session.lastWidth = rect.width;
    session.dragging = true;
    session.ghost = createDragGhost(session.el, rect, deps.ghostParent?.() ?? document.body);
    deps.geometry.beginInteraction?.();
    deps.onBegin(session.appt);
    ev.preventDefault();
  }

  function position(ev: PointerEvent) {
    if (!session?.ghost) return;
    const { geometry } = deps;
    const col = geometry.columnAt(ev.clientX);
    const date = col?.date ?? session.lastDate;
    const topMin = geometry.minutesAt(ev.clientY - session.grabOffsetPx);
    if (topMin === null) return;

    const validStarts = deps.validStartsFor(date);
    const wasValid = session.validTarget;
    const cancelTarget = date === session.originalDate && Math.abs(topMin - session.originalStart) <= MAGNET_THRESHOLD_MINUTES;
    const snapped = cancelTarget
      ? session.originalStart
      : snapDragMinutes(topMin, validStarts, deps.fine.value, MAGNET_THRESHOLD_MINUTES);
    const magnetized = validStarts.includes(snapped);
    const elapsed = deps.targetElapsed(date, snapped, session.appt.duration_minutes);
    session.cancelTarget = cancelTarget;
    session.elapsedTarget = elapsed;
    session.validTarget = cancelTarget || (!elapsed && (deps.fine.value || (deps.ready() && magnetized)));
    const y = geometry.yForMinutes(snapped);
    if (y === null) return;

    const left = col ? col.left + 2 : session.lastLeft;
    const width = col ? col.width - 4 : session.lastWidth;
    if (wasValid && date === session.lastDate && snapped === session.lastStart && left === session.lastLeft && width === session.lastWidth) {
      return;
    }
    session.lastLeft = left;
    session.lastWidth = width;
    session.ghost?.move({ top: y, left, width, height: session.heightPx });
    session.ghost?.setLabel(hhmm(snapped));

    session.lastDate = date;
    session.lastStart = snapped;
    deps.onTarget(!cancelTarget ? date : null, !cancelTarget ? snapped : null, elapsed, magnetized);
  }

  function onMove(ev: PointerEvent) {
    if (!session) return;
    if (!session.dragging) {
      const moved = Math.hypot(ev.clientX - session.downX, ev.clientY - session.downY);
      if (moved < DRAG_THRESHOLD_PX) return;
      begin(ev);
    } else {
      ev.preventDefault();
    }
    scheduleMove(ev);
  }

  function onUp() {
    if (!session) return;
    if (pendingMove) {
      if (moveFrame != null) cancelAnimationFrame(moveFrame);
      flushMove();
    }
    const { appt, dragging, lastDate, lastStart, cancelTarget, elapsedTarget } = session;
    const wasDrag = dragging;
    cleanup();
    if (wasDrag) {
      deps.onEnd();
      // Invalid free positions restore the original event. Returning to the original position is an
      // explicit cancel target even when that appointment's old slot is no longer valid.
      if (!cancelTarget && !elapsedTarget) deps.onCommit(appt, { date: lastDate, start: hhmm(lastStart) });
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && session?.dragging) {
      deps.onEnd();
      cleanup();
    }
  }

  function start(appt: Appointment, ev: PointerEvent, el: HTMLElement) {
    if (ev.button !== 0) return;
    const startDate = new Date(appt.starts_at);
    const originalDate = isoDate(startDate);
    const originalStart = startDate.getHours() * 60 + startDate.getMinutes();
    session = {
      appt,
      el,
      downX: ev.clientX,
      downY: ev.clientY,
      grabOffsetPx: ev.clientY - el.getBoundingClientRect().top,
      heightPx: el.getBoundingClientRect().height,
      dragging: false,
      ghost: null,
      lastLeft: 0,
      lastWidth: 0,
      lastDate: originalDate,
      lastStart: originalStart,
      validTarget: true,
      cancelTarget: true,
      elapsedTarget: deps.targetElapsed(originalDate, originalStart, appt.duration_minutes),
      originalDate,
      originalStart,
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  }

  return { start };
}
