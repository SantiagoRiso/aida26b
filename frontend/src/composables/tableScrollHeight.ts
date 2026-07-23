/**
 * A sticky table header only sticks to a scrollport that actually scrolls. A table wrapper that
 * scrolls horizontally is that scrollport (overflow-x: auto forces overflow-y to auto), so unless
 * its height is capped the header has nothing to stick to and leaves with the page.
 */

export interface Edges {
  top: number;
  bottom: number;
}

export interface ScrollerMetrics extends Edges {
  clientHeight: number;
  scrollTop: number;
}

/** Below this the scrolling region is too short to read; the page takes the overflow instead. */
export const MIN_TABLE_SCROLL_HEIGHT = 200;

/**
 * The height the element can take without pushing anything out of the scrollport: what is left of
 * the scroller once the content above the element and the content below it (pagination) are paid
 * for. Both of those are invariant to the element's own height, so one measurement settles it.
 */
export function availableScrollHeight(
  scroller: ScrollerMetrics,
  element: Edges,
  container: Edges,
): number {
  const above = element.top - scroller.top + scroller.scrollTop;
  const below = container.bottom - element.bottom;
  return Math.max(
    Math.round(scroller.clientHeight - above - below),
    MIN_TABLE_SCROLL_HEIGHT,
  );
}

/** The nearest ancestor that scrolls. Null means nothing does, and capping would be arbitrary. */
export function findScrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/** The measured cap as a CSS length, or null when no ancestor scrolls. */
export function measureTableScrollHeight(el: HTMLElement): string | null {
  const scroller = findScrollParent(el);
  if (!scroller) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  const container = el.parentElement ?? el;
  return `${availableScrollHeight(
    {
      top: scrollerRect.top,
      bottom: scrollerRect.bottom,
      clientHeight: scroller.clientHeight,
      scrollTop: scroller.scrollTop,
    },
    el.getBoundingClientRect(),
    container.getBoundingClientRect(),
  )}px`;
}
