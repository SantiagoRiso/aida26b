import type { EventApi, EventInput } from '@fullcalendar/core';

export const DRAG_LAYOUT_PREVIEW_ID = '__drag-layout-preview';

export interface DragPreviewCalendarApi {
  getEventById: (id: string) => { setDates: (start: string, end: string) => void; remove: () => void } | null;
  // FullCalendar returns null when the event is rejected (e.g. outside the view's date range).
  addEvent: (event: EventInput) => EventApi | null;
}

export function upsertDragLayoutPreview(api: DragPreviewCalendarApi | undefined, start: string, end: string): void {
  const preview = api?.getEventById(DRAG_LAYOUT_PREVIEW_ID);
  if (preview) {
    preview.setDates(start, end);
    return;
  }
  api?.addEvent({
    id: DRAG_LAYOUT_PREVIEW_ID,
    start,
    end,
    display: 'block',
    classNames: ['fc-drag-layout-preview'],
  });
}

export function removeDragLayoutPreview(api: DragPreviewCalendarApi | undefined): void {
  api?.getEventById(DRAG_LAYOUT_PREVIEW_ID)?.remove();
}
