// Maps pointer coordinates to calendar time and back, reading the rendered timegrid DOM. FullCalendar
// drags by a snapped delta and can't place an off-lattice block onto real slots, so we run our own
// drag (useCustomDrag) and need this bridge between screen pixels and minutes-of-day / day columns.

// Pure arithmetic, split out so it unit-tests without a DOM. `pxPerMinute` and a single reference
// lane (its top edge in client px + its minutes-of-day) define the linear screen↔time mapping.
export function minutesAtClientY(
  clientY: number,
  refLaneTop: number,
  refLaneMinutes: number,
  pxPerMinute: number,
): number {
  return refLaneMinutes + (clientY - refLaneTop) / pxPerMinute;
}

export function clientYForMinutes(
  minutes: number,
  refLaneTop: number,
  refLaneMinutes: number,
  pxPerMinute: number,
): number {
  return refLaneTop + (minutes - refLaneMinutes) * pxPerMinute;
}

interface Lane {
  top: number;
  minutes: number;
}

export interface DayColumn {
  date: string;
  left: number;
  width: number;
}

export interface TimegridGeometry {
  ready: () => boolean;
  minutesAt: (clientY: number) => number | null;
  yForMinutes: (minutes: number) => number | null;
  columnAt: (clientX: number) => DayColumn | null;
  columns: () => DayColumn[];
  pxPerMinute: () => number | null;
}

function isoTimeToMinutes(iso: string): number {
  const [h, m] = iso.split(':').map(Number);
  return h * 60 + m;
}

// Distinct body slot lanes, sorted top-down. Deduped by time so a repeated lane (axis mirror) can't
// skew the px/minute derivation.
function readLanes(root: ParentNode): Lane[] {
  const byMinutes = new Map<number, Lane>();
  root.querySelectorAll<HTMLElement>('.fc-timegrid-slot-lane[data-time]').forEach((el) => {
    const iso = el.getAttribute('data-time');
    if (!iso) return;
    const minutes = isoTimeToMinutes(iso);
    if (!byMinutes.has(minutes)) {
      byMinutes.set(minutes, { top: el.getBoundingClientRect().top, minutes });
    }
  });
  return [...byMinutes.values()].sort((a, b) => a.top - b.top);
}

// Distinct day columns, deduped by date (FC renders a structural and an event col per day at the
// same x). Read fresh each call so scrolling mid-drag stays aligned.
function readColumns(root: ParentNode): DayColumn[] {
  const byDate = new Map<string, DayColumn>();
  root.querySelectorAll<HTMLElement>('.fc-timegrid-col[data-date]').forEach((el) => {
    const date = el.getAttribute('data-date');
    if (!date || byDate.has(date)) return;
    const rect = el.getBoundingClientRect();
    byDate.set(date, { date, left: rect.left, width: rect.width });
  });
  return [...byDate.values()].sort((a, b) => a.left - b.left);
}

// `getRoot` returns the calendar's rendered root element (or null before mount). All reads happen at
// call time so the mapping tracks layout and scroll changes during a drag.
export function useTimegridGeometry(getRoot: () => ParentNode | null): TimegridGeometry {
  function reference(): { lane: Lane; pxPerMinute: number } | null {
    const root = getRoot();
    if (!root) return null;
    const lanes = readLanes(root);
    if (lanes.length < 2) return null;
    // FullCalendar renders the first (and sometimes last) slot row a fraction shorter than the rest,
    // so a single adjacent pair gives a wrong slope and the pixel↔minute mapping drifts linearly down
    // the grid. Take the median per-row slope and anchor on an interior lane, both clear of the edges.
    const slopes: number[] = [];
    for (let i = 1; i < lanes.length; i++) {
      const dm = lanes[i].minutes - lanes[i - 1].minutes;
      if (dm > 0) slopes.push((lanes[i].top - lanes[i - 1].top) / dm);
    }
    if (slopes.length === 0) return null;
    slopes.sort((a, b) => a - b);
    const pxPerMinute = slopes[Math.floor(slopes.length / 2)];
    if (!(pxPerMinute > 0)) return null;
    return { lane: lanes[Math.floor(lanes.length / 2)], pxPerMinute };
  }

  return {
    ready: () => reference() !== null,
    pxPerMinute: () => reference()?.pxPerMinute ?? null,
    minutesAt: (clientY) => {
      const ref = reference();
      return ref ? minutesAtClientY(clientY, ref.lane.top, ref.lane.minutes, ref.pxPerMinute) : null;
    },
    yForMinutes: (minutes) => {
      const ref = reference();
      return ref ? clientYForMinutes(minutes, ref.lane.top, ref.lane.minutes, ref.pxPerMinute) : null;
    },
    columnAt: (clientX) => {
      const root = getRoot();
      if (!root) return null;
      const cols = readColumns(root);
      return cols.find((c) => clientX >= c.left && clientX < c.left + c.width) ?? null;
    },
    columns: () => {
      const root = getRoot();
      return root ? readColumns(root) : [];
    },
  };
}
