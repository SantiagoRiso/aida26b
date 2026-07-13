import type { Ref } from 'vue';
import type { Appointment } from '@/api/appointments';
import { snapDragMinutes } from '@/composables/calendarGrid';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import { createDragGhost, type DragGhost } from '@/composables/dragGhost';

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
  // A real drag started (threshold crossed) — the view loads slots and shows highlights.
  onBegin: (appt: Appointment) => void;
  // Drag ended (commit or abort) — the view clears highlights and the live target.
  onEnd: () => void;
  // Live snapped target changed, for a highlight box. Null date when the pointer is off the grid.
  onTarget: (date: string | null, minutes: number | null) => void;
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
}

function hhmm(minutes: number): string {
  const clamped = Math.max(0, minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

export function useCustomDrag(deps: CustomDragDeps): {
  start: (appt: Appointment, ev: PointerEvent, el: HTMLElement) => void;
} {
  let session: Session | null = null;

  function cleanup() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
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
    // Coarse (non-sobreturno) drag only lands on real free slots. Once availability has loaded, a day
    // with none (fully booked / day off) is not a valid drop — freeze the ghost and mark the target
    // invalid instead of free-floating there. Free placement is the sobreturno (fine) privilege alone.
    // While availability is still loading, every day looks empty, so don't freeze yet — let the ghost
    // follow (the final move is still gated on commit).
    if (!deps.fine.value && deps.ready() && validStarts.length === 0) {
      session.validTarget = false;
      deps.onTarget(null, null);
      return;
    }
    session.validTarget = true;

    const snapped = snapDragMinutes(topMin, validStarts, deps.fine.value);
    const y = geometry.yForMinutes(snapped);
    if (y === null) return;

    if (col) {
      session.lastLeft = col.left + 2;
      session.lastWidth = col.width - 4;
    }
    session.ghost.move({ top: y, left: session.lastLeft, width: session.lastWidth, height: session.heightPx });
    session.ghost.setLabel(hhmm(snapped));

    session.lastDate = date;
    session.lastStart = snapped;
    deps.onTarget(date, snapped);
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
    position(ev);
  }

  function onUp() {
    if (!session) return;
    const { appt, dragging, lastDate, lastStart, validTarget } = session;
    const wasDrag = dragging;
    cleanup();
    if (wasDrag) {
      deps.onEnd();
      // Released over a booked/off day in coarse mode → no valid slot, so revert (the destroyed ghost
      // restores the event to its original spot). Only a valid target commits the move.
      if (validTarget) deps.onCommit(appt, { date: lastDate, start: hhmm(lastStart) });
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
    const pad = (n: number) => String(n).padStart(2, '0');
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
      lastDate: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
      lastStart: startDate.getHours() * 60 + startDate.getMinutes(),
      validTarget: true,
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  }

  return { start };
}
