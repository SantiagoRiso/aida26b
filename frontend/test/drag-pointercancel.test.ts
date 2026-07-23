import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ref } from 'vue';
import { useCustomDrag } from '@/composables/useCustomDrag';
import { useTemplateBlockDrag } from '@/composables/useTemplateBlockDrag';
import { dateToWeekday, type TemplateBlock, type WeekdayTimes } from '@/composables/scheduleTemplateGrid';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import type { Appointment } from '@/api/appointments';

// A finger drag that the browser reclaims as a page scroll fires pointercancel and never a pointerup.
// Without handling it the ghost stays on screen and the document listeners leak, wedging the surface.

// Identity geometry: clientY == minutes, so pointer coordinates are minutes directly.
const geometry: TimegridGeometry = {
  ready: () => true,
  minutesAt: (y) => y,
  yForMinutes: (m) => m,
  pxPerMinute: () => 1,
  columnAt: () => ({ date: '2024-01-01', left: 0, width: 100 }),
  columns: () => [],
};

function pointerEvent(type: string, clientY: number): PointerEvent {
  return new MouseEvent(type, {
    clientX: 50, clientY, button: 0, buttons: 1, bubbles: true, cancelable: true,
  }) as PointerEvent;
}

function makeEventEl(top: number, bottom: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'fc-timegrid-event';
  el.innerHTML = '<div class="fc-event-main"><div class="fc-event-time">10:00</div></div>';
  // jsdom has no layout — pin the box the drag measures itself against.
  el.getBoundingClientRect = () => ({
    top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function ghosts(): number {
  return document.querySelectorAll('.fc-drag-ghost').length;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useCustomDrag pointercancel', () => {
  const appointment = {
    id: '5', client_user_id: '1', professional_user_id: '1', resource_id: null, service_id: '1',
    starts_at: '2024-01-01T10:00:00', duration_minutes: 60, ends_at: '2024-01-01T11:00:00',
    state: 'scheduled', name: null, description: null, price: '100.00',
    override_conflict: false, override_actor_id: null, staff_note: null, conflict_ignored: false,
    created_at: '2024-01-01T10:00:00', updated_at: '2024-01-01T10:00:00',
    series_id: null, occurrence_date: null,
  } as Appointment;

  let onCommit: Mock<(appt: Appointment, target: { date: string; start: string }) => void>;
  let onEnd: Mock<() => void>;

  function makeDrag() {
    onCommit = vi.fn<(appt: Appointment, target: { date: string; start: string }) => void>();
    onEnd = vi.fn<() => void>();
    return useCustomDrag({
      geometry,
      fine: ref(true),
      validStartsFor: () => [],
      ready: () => true,
      targetElapsed: () => false,
      onBegin: () => {},
      onEnd,
      onTarget: () => {},
      onCommit,
    });
  }

  it('tears the drag down without committing when the browser reclaims the pointer', () => {
    const drag = makeDrag();
    const el = makeEventEl(600, 660);

    drag.start(appointment, pointerEvent('pointerdown', 610), el);
    document.dispatchEvent(pointerEvent('pointermove', 700));
    expect(ghosts()).toBe(1);

    document.dispatchEvent(pointerEvent('pointercancel', 700));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(ghosts()).toBe(0);
  });

  it('leaves no document listeners behind, so the next gesture starts clean', () => {
    const drag = makeDrag();
    const el = makeEventEl(600, 660);

    drag.start(appointment, pointerEvent('pointerdown', 610), el);
    document.dispatchEvent(pointerEvent('pointermove', 700));
    document.dispatchEvent(pointerEvent('pointercancel', 700));

    // A stale listener would resurrect the cancelled session and commit its last target.
    document.dispatchEvent(pointerEvent('pointermove', 900));
    document.dispatchEvent(pointerEvent('pointerup', 900));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(ghosts()).toBe(0);
  });
});

describe('useTemplateBlockDrag pointercancel', () => {
  const block: TemplateBlock = {
    id: '71', professional_user_id: '3', weekday: 'mon', start_time: '14:00', end_time: '17:20',
  };

  let onCommit: Mock<(id: string, times: WeekdayTimes) => void>;
  let onEnd: Mock<() => void>;
  let el: HTMLElement;

  beforeEach(() => {
    onCommit = vi.fn<(id: string, times: WeekdayTimes) => void>();
    onEnd = vi.fn<() => void>();
    el = makeEventEl(840, 1040);
  });

  function makeDrag() {
    return useTemplateBlockDrag({
      geometry,
      weekdayForDate: dateToWeekday,
      allBlocks: () => [block],
      onBegin: () => {},
      onEnd,
      onCommit,
    });
  }

  it('tears the drag down without committing when the browser reclaims the pointer', () => {
    const drag = makeDrag();

    drag.start(block, pointerEvent('pointerdown', 900), el);
    document.dispatchEvent(pointerEvent('pointermove', 700));
    expect(ghosts()).toBe(1);

    document.dispatchEvent(pointerEvent('pointercancel', 700));

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(ghosts()).toBe(0);
    expect(document.body.style.cursor).toBe('');
  });

  it('leaves no document listeners behind, so the next gesture starts clean', () => {
    const drag = makeDrag();

    drag.start(block, pointerEvent('pointerdown', 900), el);
    document.dispatchEvent(pointerEvent('pointermove', 700));
    document.dispatchEvent(pointerEvent('pointercancel', 700));

    document.dispatchEvent(pointerEvent('pointermove', 500));
    document.dispatchEvent(pointerEvent('pointerup', 500));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(ghosts()).toBe(0);
  });
});
