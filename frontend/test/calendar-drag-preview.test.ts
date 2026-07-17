import { describe, expect, it, vi } from 'vitest';
import {
  DRAG_LAYOUT_PREVIEW_ID,
  removeDragLayoutPreview,
  upsertDragLayoutPreview,
  type DragPreviewCalendarApi,
} from '@/composables/calendarDragPreview';

describe('calendar drag layout preview', () => {
  it('adds the transient event without replacing the calendar event source', () => {
    const addEvent = vi.fn();
    const api: DragPreviewCalendarApi = { getEventById: () => null, addEvent };

    upsertDragLayoutPreview(api, '2099-01-02T14:40:00', '2099-01-02T15:30:00');

    expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: DRAG_LAYOUT_PREVIEW_ID,
      start: '2099-01-02T14:40:00',
      end: '2099-01-02T15:30:00',
    }));
  });

  it('updates the existing event in place', () => {
    const setDates = vi.fn();
    const addEvent = vi.fn();
    const api: DragPreviewCalendarApi = {
      getEventById: () => ({ setDates, remove: vi.fn() }),
      addEvent,
    };

    upsertDragLayoutPreview(api, '2099-01-02T15:00:00', '2099-01-02T15:50:00');

    expect(setDates).toHaveBeenCalledWith('2099-01-02T15:00:00', '2099-01-02T15:50:00');
    expect(addEvent).not.toHaveBeenCalled();
  });

  it('removes the transient event at drag end', () => {
    const remove = vi.fn();
    const api: DragPreviewCalendarApi = {
      getEventById: () => ({ setDates: vi.fn(), remove }),
      addEvent: vi.fn(),
    };

    removeDragLayoutPreview(api);

    expect(remove).toHaveBeenCalledOnce();
  });
});
