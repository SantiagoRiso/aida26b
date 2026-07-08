import type { Ref } from 'vue';
import type { Appointment } from '@/api/appointments';
import { snapDragMinutes } from '@/composables/calendarGrid';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';

// A drag we drive ourselves instead of FullCalendar's. FC moves an event by a snapped delta from its
// original start, so a block that begins off the lattice (a sobreturno) can never step onto real slots
// mid-drag. Owning the drag lets us snap the block's absolute position to the professional's slots on
// every pointer move — coarse lands on real slots, sobreturno mode places freely at 5 min. Native FC
// event-move is disabled (eventStartEditable:false); resize stays native.

const DRAG_THRESHOLD_PX = 4;

export interface CustomDragDeps {
  geometry: TimegridGeometry;
  fine: Ref<boolean>;
  // Valid slot starts (minutes-of-day) for a day, for coarse snapping. Empty when unknown or none.
  validStartsFor: (date: string) => number[];
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
  ghost: HTMLElement | null;
  lastDate: string;
  lastStart: number; // snapped minutes-of-day
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
    if (session?.ghost) session.ghost.remove();
    if (session) session.el.style.opacity = '';
    session = null;
  }

  function makeGhost(el: HTMLElement, rect: DOMRect): HTMLElement {
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add('fc-drag-ghost');
    Object.assign(ghost.style, {
      position: 'fixed',
      margin: '0',
      transform: 'none',
      transition: 'none',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      pointerEvents: 'none',
      zIndex: '9999',
    });
    document.body.appendChild(ghost);
    return ghost;
  }

  function begin(ev: PointerEvent) {
    if (!session) return;
    const rect = session.el.getBoundingClientRect();
    session.heightPx = rect.height;
    session.dragging = true;
    session.ghost = makeGhost(session.el, rect);
    session.el.style.opacity = '0.35';
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

    const snapped = snapDragMinutes(topMin, deps.validStartsFor(date), deps.fine.value);
    const y = geometry.yForMinutes(snapped);
    if (y === null) return;

    if (col) {
      session.ghost.style.left = `${col.left + 2}px`;
      session.ghost.style.width = `${col.width - 4}px`;
    }
    session.ghost.style.top = `${y}px`;
    session.ghost.style.height = `${session.heightPx}px`;

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
    const { appt, dragging, lastDate, lastStart } = session;
    const wasDrag = dragging;
    cleanup();
    if (wasDrag) {
      deps.onEnd();
      deps.onCommit(appt, { date: lastDate, start: hhmm(lastStart) });
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
      lastDate: `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`,
      lastStart: startDate.getHours() * 60 + startDate.getMinutes(),
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  }

  return { start };
}
