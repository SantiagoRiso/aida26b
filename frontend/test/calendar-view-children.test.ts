import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import type { EventInput } from '@fullcalendar/core';
import CalendarFilterBar from '@/components/calendar/CalendarFilterBar.vue';
import CalendarSurface from '@/components/calendar/CalendarSurface.vue';
import CalendarDialogs from '@/components/calendar/CalendarDialogs.vue';
import CalendarViewComponent from '@/components/calendar/CalendarView.vue';

vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  deleteRow: vi.fn().mockResolvedValue({ ok: true, data: {} }),
}));

// AppointmentDetailPanel reads the business cancellation cutoff on mount.
vi.mock('@/api/business', () => ({
  getMySettings: vi.fn().mockResolvedValue({ ok: false, status: 500, code: 'x', message: 'x' }),
}));

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('CalendarFilterBar', () => {
  it('shows the sobreturno toggle only for staff and re-emits its changes', async () => {
    const wrapper = mount(CalendarFilterBar, {
      props: { canSobreturno: true, fineDrag: false },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();
    const checkbox = wrapper.find('input[type="checkbox"]');
    expect(checkbox.exists()).toBe(true);
    await checkbox.setValue(true);
    expect(wrapper.emitted('update:fineDrag')).toEqual([[true]]);
  });

  it('hides the toggle when sobreturno is not allowed', async () => {
    const wrapper = mount(CalendarFilterBar, {
      props: { canSobreturno: false, fineDrag: false },
      global: { plugins: [makeI18n()] },
    });
    await flushPromises();
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });
});

describe('CalendarSurface', () => {
  function surfaceProps() {
    return {
      baseOptions: { events: [{ id: 'appt-1' }] as EventInput[] },
      fineDrag: false,
      currentViewType: 'timeGridWeek',
      visibleRange: { from: '2099-01-01', to: '2099-01-08' },
      professionalId: null,
      resourceId: null,
      professionalBlocks: [],
      businessClosures: [{
        id: '1', exception_date: '2099-01-02',
        start_time: null, end_time: null, reason: 'Feriado',
      }],
      monthAvailability: new Map(),
      resourceFreeByDay: new Map(),
      professionalFreeByDay: new Map(),
      bookedByDate: new Map(),
      highlightStartsByDay: new Map(),
      dragOrigin: null,
      dragDurationMinutes: 0,
      slotMinutes: null,
      slotStartsMinutes: null,
      exceptionBgEvents: [],
      hoverEvents: [],
      hoverPreviewEvents: [],
      dragLayoutPreviewEvents: [],
      cellElapsed: () => false,
      slotBookableByAvailability: () => true,
    };
  }

  it('merges the base events with the derived background layers', () => {
    const wrapper = mount(CalendarSurface, {
      props: surfaceProps(),
      global: { stubs: { CalendarViewComponent: true } },
    });
    const inner = wrapper.findComponent(CalendarViewComponent);
    expect(inner.exists()).toBe(true);
    const options = inner.props('options');
    const events = options.events as EventInput[];
    expect(events.some((e) => e.id === 'appt-1')).toBe(true);
    // A full-day closure renders as a background band covering the whole day.
    const closure = events.find((e) => (e.classNames as string[] | undefined)?.includes('fc-closure'));
    expect(closure).toBeDefined();
    expect(closure?.start).toBe('2099-01-02T00:00:00');
    expect(closure?.end).toBe('2099-01-03T00:00:00');
  });

  it('keeps the drag layout preview when hover layers refresh', async () => {
    const wrapper = mount(CalendarSurface, {
      props: {
        ...surfaceProps(),
        dragLayoutPreviewEvents: [{
          id: '__drag-layout-preview',
          start: '2099-01-02T14:40:00',
          end: '2099-01-02T15:30:00',
          classNames: ['fc-drag-layout-preview'],
        }],
      },
      global: { stubs: { CalendarViewComponent: true } },
    });

    await wrapper.setProps({ hoverEvents: [{ start: '2099-01-02T15:00:00', display: 'background' }] });
    const events = wrapper.findComponent(CalendarViewComponent).props('options').events as EventInput[];
    expect(events.some((event) => event.id === '__drag-layout-preview')).toBe(true);
  });

  it('shows the cancel origin and hides drop boxes that overlap bookings', () => {
    const props = {
      ...surfaceProps(),
      dragDurationMinutes: 60,
      dragOrigin: { date: '2099-01-02', minutes: 9 * 60, duration: 60 },
      highlightStartsByDay: new Map([['2099-01-02', ['09:00', '11:00']]]),
      bookedByDate: new Map([['2099-01-02', {
        occupied: [{ start: 9 * 60 + 30, end: 10 * 60 + 30 }],
        requested: [],
      }]]),
    };

    const wrapper = mount(CalendarSurface, {
      props,
      global: { stubs: { CalendarViewComponent: true } },
    });
    const events = wrapper.findComponent(CalendarViewComponent).props('options').events as EventInput[];
    const free = events.filter((event) => {
      const classes = event.classNames as string[] | undefined;
      return classes?.includes('fc-slot-free') && !classes.includes('fc-slot-origin');
    });
    const origin = events.find((event) => (event.classNames as string[] | undefined)?.includes('fc-slot-origin'));

    expect(free).toHaveLength(1);
    expect(free[0]?.start).toBe('2099-01-02T11:00:00');
    expect(origin?.start).toBe('2099-01-02T09:00:00');
    expect(origin?.end).toBe('2099-01-02T10:00:00');
  });

  it('disables native select in timegrid views and keeps height at 100%', () => {
    const wrapper = mount(CalendarSurface, {
      props: surfaceProps(),
      global: { stubs: { CalendarViewComponent: true } },
    });
    const options = wrapper.findComponent(CalendarViewComponent).props('options');
    expect(options.height).toBe('100%');
    expect(options.views?.timeGridWeek?.selectable).toBe(false);
    expect(options.views?.timeGridDay?.selectable).toBe(false);
  });
});

describe('CalendarDialogs', () => {
  it('mounts with everything closed without rendering any overlay', () => {
    const wrapper = mount(CalendarDialogs, {
      props: {
        detailAppointment: null,
        detailOpen: false,
        formOpen: false,
        prefillSobreturno: false,
        moveConfirmOpen: false,
        moveConfirmBody: '',
        conflictOpen: false,
        conflictVerdict: null,
        conflictRevert: null,
      },
      global: { plugins: [makeI18n()] },
    });
    expect(wrapper.find('input').exists()).toBe(false);
    expect(document.body.textContent ?? '').not.toContain('Confirmar');
  });
});
