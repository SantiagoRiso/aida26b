import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import { otherBlockEdges, type TemplateBlock } from '@/composables/scheduleTemplateGrid';
import { toMinutes } from '@shared/ssot/domain';
import type { Weekday } from '@shared/ssot/domain';
import { placeMove, placeResizeTop, placeResizeBottom, freeWindows, type MinuteInterval } from '@/composables/templateBlockPlacement';
import { createDragGhost, type DragGhost } from '@/composables/dragGhost';

// A move/resize we drive ourselves instead of FullCalendar's. FC only snaps a drag to its fixed time
// lattice and can never pull an edge onto a *neighbouring block's* boundary, so we own the interaction:
// on every pointer move we clamp the block inside the free time around its neighbours (overlap becomes
// impossible) and snap an edge onto a nearby block edge. A live ghost shows the result. FC-native event
// editing is disabled for the template grid; drag-to-create stays native (snaps on release).

const DRAG_THRESHOLD_PX = 4;
const RESIZE_EDGE_PX = 8;

type Mode = 'move' | 'resize-top' | 'resize-bottom';

export interface TemplateDragDeps {
  geometry: TimegridGeometry;
  weekdayForDate: (date: string) => Weekday;
  // Every block currently rendered — the composable filters to the relevant weekday and drops self.
  allBlocks: () => TemplateBlock[];
  // Where the ghost is appended — the calendar root, so it inherits the block's scoped CSS 1:1. Falls
  // back to <body> (e.g. in tests) where that styling doesn't matter.
  ghostParent?: () => HTMLElement | null;
  onBegin: () => void;
  onEnd: () => void;
  onCommit: (id: string, times: { weekday: Weekday; start_time: string; end_time: string }) => void;
}

interface Session {
  block: TemplateBlock;
  startMin: number;
  endMin: number;
  duration: number;
  el: HTMLElement;
  mode: Mode;
  downX: number;
  downY: number;
  grabOffsetPx: number;
  // The block's own rendered box, captured at grab — the ghost's vertical mapping is anchored to it so
  // the same time always lands on the same pixel as the real block (no lane-vs-event drift).
  topPx: number;
  leftPx: number;
  widthPx: number;
  pxPerMin: number;
  dragging: boolean;
  ghost: DragGhost | null;
  last: { weekday: Weekday; start: number; end: number };
}

// Not toHHMM: values can be fractional/negative mid-drag, this rounds and clamps before formatting.
function hhmm(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const clamped = Math.max(0, Math.round(minutes));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

export function useTemplateBlockDrag(deps: TemplateDragDeps): {
  start: (block: TemplateBlock, ev: PointerEvent, el: HTMLElement) => void;
} {
  let session: Session | null = null;

  function neighboursOn(weekday: Weekday, ignoreId: string): MinuteInterval[] {
    return deps.allBlocks()
      .filter((b) => b.weekday === weekday && b.id !== ignoreId)
      .map((b) => ({ start: toMinutes(b.start_time), end: toMinutes(b.end_time) }));
  }

  // Vertical mapping anchored to the block's own captured box, so a minute maps to the exact pixel the
  // real block occupies (FC's event placement and the lane grid can disagree by a pixel or two).
  function yAt(minute: number): number {
    return session ? session.topPx + (minute - session.startMin) * session.pxPerMin : 0;
  }
  function minuteAt(clientY: number): number {
    return session ? session.startMin + (clientY - session.topPx) / session.pxPerMin : 0;
  }

  function cleanup() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    session?.ghost?.destroy();
    document.body.style.cursor = '';
    session = null;
  }

  function begin(ev: PointerEvent) {
    if (!session) return;
    session.dragging = true;
    session.ghost = createDragGhost(session.el, session.el.getBoundingClientRect(), deps.ghostParent?.() ?? document.body);
    document.body.style.cursor = session.mode === 'move' ? 'grabbing' : 'ns-resize';
    deps.onBegin();
    ev.preventDefault();
  }

  function paint(startMin: number, endMin: number, col?: { left: number; width: number }) {
    if (!session?.ghost) return;
    session.ghost.move({
      top: yAt(startMin),
      height: (endMin - startMin) * session.pxPerMin,
      left: col?.left ?? session.leftPx,
      width: col?.width ?? session.widthPx,
    });
    // Rewrite the label live so the snap is visible (e.g. "13:10 - 17:20" the instant the top edge snaps).
    session.ghost.setLabel(`${hhmm(startMin)} - ${hhmm(endMin)}`);
  }

  function position(ev: PointerEvent) {
    if (!session?.ghost) return;
    const { geometry } = deps;
    const s = session;

    // Snap targets: every OTHER block's start/end across all days, so edges line up between blocks.
    const edges = otherBlockEdges(deps.allBlocks(), s.block.id);

    if (s.mode === 'move') {
      const col = geometry.columnAt(ev.clientX);
      const weekday = col ? deps.weekdayForDate(col.date) : s.last.weekday;
      const windows = freeWindows(neighboursOn(weekday, s.block.id));
      const start = placeMove(s.duration, minuteAt(ev.clientY - s.grabOffsetPx), windows, edges);
      if (start === null) return; // no room on this day — keep the last valid spot
      s.last = { weekday, start, end: start + s.duration };
      paint(start, start + s.duration, col ?? undefined);
      return;
    }

    const weekday = s.block.weekday;
    const windows = freeWindows(neighboursOn(weekday, s.block.id));
    const block: MinuteInterval = { start: s.startMin, end: s.endMin };
    if (s.mode === 'resize-top') {
      const start = placeResizeTop(block, minuteAt(ev.clientY), windows, edges);
      s.last = { weekday, start, end: s.endMin };
      paint(start, s.endMin);
    } else {
      const end = placeResizeBottom(block, minuteAt(ev.clientY), windows, edges);
      s.last = { weekday, start: s.startMin, end };
      paint(s.startMin, end);
    }
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
    const { block, dragging, last } = session;
    const changed = last.weekday !== block.weekday || last.start !== toMinutes(block.start_time) || last.end !== toMinutes(block.end_time);
    cleanup();
    if (dragging) {
      deps.onEnd();
      if (changed) deps.onCommit(block.id, { weekday: last.weekday, start_time: hhmm(last.start), end_time: hhmm(last.end) });
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && session?.dragging) {
      deps.onEnd();
      cleanup();
    }
  }

  function modeFor(ev: PointerEvent, rect: DOMRect): Mode {
    const edge = Math.min(RESIZE_EDGE_PX, rect.height / 3);
    if (ev.clientY <= rect.top + edge) return 'resize-top';
    if (ev.clientY >= rect.bottom - edge) return 'resize-bottom';
    return 'move';
  }

  function start(block: TemplateBlock, ev: PointerEvent, el: HTMLElement) {
    if (ev.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const startMin = toMinutes(block.start_time);
    const endMin = toMinutes(block.end_time);
    const duration = endMin - startMin;
    session = {
      block,
      startMin,
      endMin,
      duration,
      el,
      mode: modeFor(ev, rect),
      downX: ev.clientX,
      downY: ev.clientY,
      grabOffsetPx: ev.clientY - rect.top,
      topPx: rect.top,
      leftPx: rect.left,
      widthPx: rect.width,
      pxPerMin: duration > 0 ? rect.height / duration : (deps.geometry.pxPerMinute() ?? 1),
      dragging: false,
      ghost: null,
      last: { weekday: block.weekday, start: startMin, end: endMin },
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKey);
  }

  return { start };
}
