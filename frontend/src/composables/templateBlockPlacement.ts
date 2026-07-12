// Pure placement math for the live (mid-drag) move/resize of schedule-template blocks. Split out from
// the DOM interaction (useTemplateBlockDrag) so it unit-tests without a calendar. Every result clamps
// the block inside the free time around its neighbours — overlap is impossible by construction — and
// snaps an edge flush to a neighbour boundary when it lands within SNAP_THRESHOLD_MINUTES, otherwise to
// a coarse grid step for a steady feel between magnets.

import { nearestEdgeWithin } from './scheduleTemplateGrid';

// Match the template calendar's visible range (slotMinTime/slotMaxTime in useScheduleTemplate).
export const DAY_MIN_MINUTES = 6 * 60;
export const DAY_MAX_MINUTES = 23 * 60;
// The smallest block a resize may leave.
export const MIN_BLOCK_MINUTES = 5;

export interface MinuteInterval { start: number; end: number; }

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// The gaps a block may occupy on one weekday: the complement of its (self-excluded) neighbours within
// the visible day bounds. The edited block is not a neighbour, so its own span stays part of a window.
export function freeWindows(neighbours: MinuteInterval[]): MinuteInterval[] {
  const sorted = [...neighbours].sort((a, b) => a.start - b.start);
  const out: MinuteInterval[] = [];
  let cursor = DAY_MIN_MINUTES;
  for (const n of sorted) {
    const start = clamp(n.start, DAY_MIN_MINUTES, DAY_MAX_MINUTES);
    if (start > cursor) out.push({ start: cursor, end: start });
    cursor = Math.max(cursor, clamp(n.end, DAY_MIN_MINUTES, DAY_MAX_MINUTES));
  }
  if (cursor < DAY_MAX_MINUTES) out.push({ start: cursor, end: DAY_MAX_MINUTES });
  return out.filter((w) => w.end > w.start);
}

// The window that fully contains the block's current span (a non-overlapping block always lies inside
// exactly one free window). Null if the span isn't contained — the caller keeps the last valid spot.
export function enclosingWindow(windows: MinuteInterval[], blockStart: number, blockEnd: number): MinuteInterval | null {
  return windows.find((w) => w.start <= blockStart && blockEnd <= w.end) ?? null;
}

// Snap `value` onto the nearest block edge within range (per-minute otherwise), then keep it inside the
// valid [lo, hi]. Same-day neighbour boundaries are already in `edges`, so a resize meets its adjacent
// block naturally; snapping to a far day's matching edge (e.g. a shared 14:00 start) works too.
function snapWithin(value: number, edges: number[], lo: number, hi: number): number {
  const c = clamp(value, lo, hi);
  return clamp(nearestEdgeWithin(c, edges) ?? Math.round(c), lo, hi);
}

// Resize the top edge (start moves, end fixed): clamp within the enclosing window and min-duration,
// snapping the start onto the nearest block edge. Returns the new start (minutes).
export function placeResizeTop(block: MinuteInterval, desiredStart: number, windows: MinuteInterval[], edges: number[]): number {
  const w = enclosingWindow(windows, block.start, block.end);
  const lo = w ? w.start : DAY_MIN_MINUTES;
  const hi = block.end - MIN_BLOCK_MINUTES;
  return snapWithin(desiredStart, edges, lo, hi);
}

// Resize the bottom edge (end moves, start fixed): clamp within the enclosing window and min-duration,
// snapping the end onto the nearest block edge. Returns the new end (minutes).
export function placeResizeBottom(block: MinuteInterval, desiredEnd: number, windows: MinuteInterval[], edges: number[]): number {
  const w = enclosingWindow(windows, block.start, block.end);
  const lo = block.start + MIN_BLOCK_MINUTES;
  const hi = w ? w.end : DAY_MAX_MINUTES;
  return snapWithin(desiredEnd, edges, lo, hi);
}

// Move a fixed-duration block to `desiredStart` on a day whose free windows are given. Places it in the
// window nearest the pointer that can hold the duration; either edge may snap onto a block boundary
// (whichever is closer). Returns the new start (minutes), or null when no window can fit the block.
export function placeMove(duration: number, desiredStart: number, windows: MinuteInterval[], edges: number[]): number | null {
  const fits = windows.filter((w) => w.end - w.start >= duration);
  if (fits.length === 0) return null;
  const targetFor = (w: MinuteInterval) => clamp(desiredStart, w.start, w.end - duration);
  const best = fits.reduce((a, b) =>
    Math.abs(targetFor(b) - desiredStart) < Math.abs(targetFor(a) - desiredStart) ? b : a,
  );
  const lo = best.start;
  const hi = best.end - duration;
  const clamped = clamp(desiredStart, lo, hi);
  // The start can snap onto an edge directly, or the end can snap (pulling the start to edge - duration).
  // Pick whichever lands closer to where the pointer is; per-minute when neither is in range.
  const startEdge = nearestEdgeWithin(clamped, edges);
  const endEdge = nearestEdgeWithin(clamped + duration, edges);
  const candidates: number[] = [];
  if (startEdge !== null) candidates.push(startEdge);
  if (endEdge !== null) candidates.push(endEdge - duration);
  const start = candidates.length
    ? candidates.reduce((a, b) => (Math.abs(b - clamped) < Math.abs(a - clamped) ? b : a))
    : Math.round(clamped);
  return clamp(start, lo, hi);
}
