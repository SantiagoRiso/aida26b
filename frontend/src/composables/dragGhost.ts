// The drag preview shared by the calendar move-drag (useCustomDrag) and the schedule-editor move/resize
// (useTemplateBlockDrag). A flat, in-place clone of the dragged event — no shadow or opacity lift —
// appended to the calendar root so its scoped :deep() CSS (radius, padding, colour, state classes)
// applies to it exactly as to the real event. Slightly translucent so it reads as a live preview; the
// original is hidden while dragging, so what the user sees is the event itself moving/resizing, not a
// copy floating above it. Positioning math stays in each composable — this only owns the visual.

export interface DragGhost {
  move(box: { top: number; left: number; width: number; height: number }): void;
  // Rewrite the event's time label live (FC default `.fc-event-time`, or the compact `.fc-ev-time`).
  setLabel(text: string): void;
  destroy(): void;
}

export function createDragGhost(source: HTMLElement, rect: DOMRect, parent: HTMLElement): DragGhost {
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add('fc-drag-ghost');
  Object.assign(ghost.style, {
    position: 'fixed',
    margin: '0',
    transform: 'none',
    transition: 'none',
    boxShadow: 'none',
    opacity: '0.7',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: 'none',
    zIndex: '5',
  });
  parent.appendChild(ghost);
  const prevOpacity = source.style.opacity;
  source.style.opacity = '0';

  return {
    move({ top, left, width, height }) {
      ghost.style.top = `${top}px`;
      ghost.style.left = `${left}px`;
      ghost.style.width = `${width}px`;
      ghost.style.height = `${height}px`;
    },
    setLabel(text) {
      const label = ghost.querySelector('.fc-event-time, .fc-ev-time');
      if (label) label.textContent = text;
    },
    destroy() {
      ghost.remove();
      source.style.opacity = prevOpacity;
    },
  };
}
