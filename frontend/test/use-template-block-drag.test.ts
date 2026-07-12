import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useTemplateBlockDrag } from '@/composables/useTemplateBlockDrag';
import type { TemplateBlock } from '@/composables/scheduleTemplateGrid';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import { dateToWeekday } from '@/composables/scheduleTemplateGrid';

// A block Mon 14:00-17:20 with a morning neighbour Mon 09:00-13:10 (its end at 790 min = 13:10).
const target: TemplateBlock = { id: '71', professional_user_id: '3', weekday: 'mon', start_time: '14:00', end_time: '17:20' };
const morning: TemplateBlock = { id: '1', professional_user_id: '3', weekday: 'mon', start_time: '09:00', end_time: '13:10' };

// Identity geometry: clientY == minutes, so tests drive minutes directly through pointer coordinates.
const geometry: TimegridGeometry = {
  ready: () => true,
  minutesAt: (y) => y,
  yForMinutes: (m) => m,
  pxPerMinute: () => 1,
  columnAt: () => ({ date: '2024-01-01', left: 0, width: 100 }),
  columns: () => [],
};

function makeBlockEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fc-timegrid-event';
  el.innerHTML = '<div class="fc-event-main"><div class="fc-event-time">14:00 - 17:20</div></div>';
  // jsdom has no layout — pin the block's box to 14:00-17:20 (top 840, bottom 1040).
  el.getBoundingClientRect = () => ({ top: 840, bottom: 1040, left: 0, right: 100, width: 100, height: 200, x: 0, y: 840, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

function pointerEvent(type: string, clientY: number): MouseEvent {
  return new MouseEvent(type, { clientX: 50, clientY, button: 0, buttons: 1, bubbles: true, cancelable: true });
}

function pointer(type: string, clientY: number, tgt: EventTarget): void {
  tgt.dispatchEvent(pointerEvent(type, clientY));
}

describe('useTemplateBlockDrag', () => {
  let onCommit: ReturnType<typeof vi.fn>;
  let onBegin: ReturnType<typeof vi.fn>;
  let onEnd: ReturnType<typeof vi.fn>;
  let el: HTMLElement;

  beforeEach(() => {
    onCommit = vi.fn();
    onBegin = vi.fn();
    onEnd = vi.fn();
    el = makeBlockEl();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.querySelectorAll('.fc-template-ghost').forEach((g) => g.remove());
  });

  function makeDrag() {
    return useTemplateBlockDrag({
      geometry,
      weekdayForDate: dateToWeekday,
      allBlocks: () => [target, morning],
      onBegin,
      onEnd,
      onCommit,
    });
  }

  it('resizes the top edge, snaps flush to the neighbour, and updates the ghost label live', () => {
    const drag = makeDrag();
    // Press on the top edge (840 + 3, within the 8px resize zone) → resize-top. The view's delegated
    // listener hands the pointerdown to start(); replicate that here.
    drag.start(target, pointerEvent('pointerdown', 843) as PointerEvent, el);
    // Drag up to 13:15 (795) — within 10 min of the 13:10 (790) neighbour end.
    pointer('pointermove', 795, document);

    expect(onBegin).toHaveBeenCalled();
    const ghostLabel = document.querySelector('.fc-template-ghost .fc-event-time')?.textContent;
    expect(ghostLabel).toBe('13:10 - 17:20'); // snapped flush, shown live

    pointer('pointerup', 795, document);
    expect(onCommit).toHaveBeenCalledWith('71', { weekday: 'mon', start_time: '13:10', end_time: '17:20' });
    expect(onEnd).toHaveBeenCalled();
  });

  it('does not begin a drag or commit on a plain click (no movement past threshold)', () => {
    const drag = makeDrag();
    drag.start(target, pointerEvent('pointerdown', 900) as PointerEvent, el); // mid-body
    pointer('pointerup', 900, document);

    expect(onBegin).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.querySelector('.fc-template-ghost')).toBeNull();
  });

  it('moves the whole block and cannot overlap the neighbour (clamped into the free window)', () => {
    const drag = makeDrag();
    // Grab mid-body (900) and drag up hard toward the morning block. duration 200; only the
    // 790-1380 window fits it, so the top clamps to 790 at most (never crossing 13:10).
    drag.start(target, pointerEvent('pointerdown', 900) as PointerEvent, el);
    pointer('pointermove', 500, document); // way up
    pointer('pointerup', 500, document);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const [, times] = onCommit.mock.calls[0];
    expect(times.start_time).toBe('13:10'); // flush to the neighbour end, no overlap
    expect(times.end_time).toBe('16:30');   // 790 + 200 min
  });
});
