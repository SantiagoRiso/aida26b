import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';
import type { EventInput, EventClickArg } from '@fullcalendar/core';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useCustomDrag } from '@/composables/useCustomDrag';
import type { TimegridGeometry } from '@/composables/useTimegridGeometry';
import { toDisplayAppointment, appointmentKey, isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { dayISO } from '@/composables/availabilityShading';
import { useAuthStore } from '@/stores/auth';
import type { Appointment } from '@/api/appointments';
import type { AuthUser } from '@/stores/auth';
import type { VirtualOccurrence } from '@shared/ssot/query-types';

vi.mock('@/api/appointments', () => ({
  listAppointments: vi.fn(),
  transitionAppointment: vi.fn(),
  materializeOccurrence: vi.fn(),
}));
vi.mock('@/api/crud', () => ({
  listRows: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));
vi.mock('@/api/business', () => ({
  getMySettings: vi.fn().mockResolvedValue({
    ok: true, data: { id: '1', cancellation_cutoff_hours: 24, min_booking_days: 0, max_booking_days: null },
  }),
}));

import { listAppointments } from '@/api/appointments';
import AppointmentsView from '@/views/portal/AppointmentsView.vue';

// Now-relative fixture — never a hardcoded calendar date (repo rule): the "upcoming" filter in
// AppointmentsView compares against `new Date()`, so a fixed past date would silently drop out.
const OCCURRENCE_DATE = dayISO(new Date(), 3);
const STARTS_AT = `${OCCURRENCE_DATE}T13:00:00.000Z`;

function makeVirtual(overrides: Partial<VirtualOccurrence> = {}): VirtualOccurrence {
  return {
    id: null,
    series_id: '9',
    occurrence_date: OCCURRENCE_DATE,
    client_user_id: '4',
    professional_user_id: '2',
    service_id: '3',
    resource_id: null,
    starts_at: STARTS_AT,
    duration_minutes: 30,
    price: '5000.00',
    state: 'scheduled',
    name: null,
    description: null,
    is_virtual: true,
    in_conflict: false,
    ...overrides,
  };
}

function makeI18n() {
  return createI18n({ legacy: false, locale: 'es', messages: { es, en } });
}

const adminViewer: AuthUser = {
  id: 1, username: 'admin', email: null, role: 'Admin',
  business_id: null, is_active: true, must_change_password: false,
};

const noop = () => {};
const baseHandlers = { onSelect: noop, onEventClick: noop, onEventDrop: noop, onEventResize: noop };

describe('isVirtualOccurrence / appointmentKey / toDisplayAppointment', () => {
  it('identifies a virtual occurrence by its is_virtual flag', () => {
    expect(isVirtualOccurrence(makeVirtual())).toBe(true);
  });

  it('builds a deterministic synthetic key from series_id + occurrence_date', () => {
    expect(appointmentKey(makeVirtual())).toBe(`virtual:9:${OCCURRENCE_DATE}`);
  });

  it('a real appointment keeps its own id', () => {
    const real: Appointment = {
      id: '42', client_user_id: '4', professional_user_id: '2', resource_id: null, service_id: '3',
      starts_at: STARTS_AT, duration_minutes: 30, ends_at: STARTS_AT, state: 'scheduled',
      name: null, description: null, price: '5000.00', override_conflict: false, override_actor_id: null,
      staff_note: null, conflict_ignored: false, created_at: STARTS_AT, updated_at: STARTS_AT,
      series_id: null, occurrence_date: null,
    };
    expect(appointmentKey(real)).toBe('42');
    expect(toDisplayAppointment(real)).toBe(real);
  });

  it('normalizes a virtual occurrence to the Appointment shape with a synthetic id and computed ends_at', () => {
    const display = toDisplayAppointment(makeVirtual());
    expect(display.id).toBe(`virtual:9:${OCCURRENCE_DATE}`);
    expect(display.ends_at).toBe(new Date(new Date(STARTS_AT).getTime() + 30 * 60000).toISOString());
    expect(display.is_virtual).toBe(true);
    expect(display.series_id).toBe('9');
    expect(display.occurrence_date).toBe(OCCURRENCE_DATE);
    // Fields a virtual has no row for yet — filled with inert defaults, not left undefined.
    expect(display.override_conflict).toBe(false);
    expect(display.override_actor_id).toBeNull();
    expect(display.staff_note).toBeNull();
    expect(display.conflict_ignored).toBe(false);
  });
});

describe('calendar event mapping for a virtual occurrence', () => {
  it('renders with the synthetic id and the fc-virtual-occurrence class', () => {
    const display = toDisplayAppointment(makeVirtual());
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([display]), ref(adminViewer), baseHandlers);
    const event = (calendarOptions.value.events as EventInput[])[0]!;
    expect(event.id).toBe(`virtual:9:${OCCURRENCE_DATE}`);
    expect(event.classNames).toContain('fc-virtual-occurrence');
  });

  it('an in_conflict virtual also carries the existing in-conflict class (reused, not forked)', () => {
    const display = toDisplayAppointment(makeVirtual({ in_conflict: true }));
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([display]), ref(adminViewer), baseHandlers);
    const event = (calendarOptions.value.events as EventInput[])[0]!;
    expect(event.classNames).toContain('fc-virtual-occurrence');
    expect(event.classNames).toContain('appt-in-conflict');
  });

  it('a plain (non-conflicted) virtual does not carry the in-conflict class', () => {
    const display = toDisplayAppointment(makeVirtual());
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([display]), ref(adminViewer), baseHandlers);
    const event = (calendarOptions.value.events as EventInput[])[0]!;
    expect(event.classNames).not.toContain('appt-in-conflict');
  });

  it('is not natively editable, independent of the viewer/view editable flags', () => {
    const display = toDisplayAppointment(makeVirtual());
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([display]), ref(adminViewer), baseHandlers);
    const event = (calendarOptions.value.events as EventInput[])[0]!;
    expect(event.editable).toBe(false);
    expect(event.startEditable).toBe(false);
    expect(event.durationEditable).toBe(false);
  });

  it('a real appointment is unaffected: no virtual class, no per-event editable override', () => {
    const real: Appointment = {
      id: '42', client_user_id: '4', professional_user_id: '2', resource_id: null, service_id: '3',
      starts_at: STARTS_AT, duration_minutes: 30, ends_at: STARTS_AT, state: 'scheduled',
      name: null, description: null, price: '5000.00', override_conflict: false, override_actor_id: null,
      staff_note: null, conflict_ignored: false, created_at: STARTS_AT, updated_at: STARTS_AT,
      series_id: null, occurrence_date: null,
    };
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([real]), ref(adminViewer), baseHandlers);
    const event = (calendarOptions.value.events as EventInput[])[0]!;
    expect(event.id).toBe('42');
    expect(event.classNames).not.toContain('fc-virtual-occurrence');
    expect(event.editable).toBeUndefined();
  });

  it('clicking the event hands the detail flow a fully-populated virtual (is_virtual/series_id/occurrence_date)', () => {
    const display = toDisplayAppointment(makeVirtual());
    let opened: Appointment | undefined;
    // Mirrors CalendarView.vue's handleEventClick: extract extendedProps.appointment and open the
    // detail panel with it — Task 12's resolveActionable then materializes on the first real action.
    const handlers = {
      ...baseHandlers,
      onEventClick: (arg: EventClickArg) => {
        opened = (arg.event.extendedProps as { appointment: Appointment }).appointment;
      },
    };
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([display]), ref(adminViewer), handlers);
    const event = (calendarOptions.value.events as EventInput[])[0]!;
    (calendarOptions.value.eventClick as (arg: EventClickArg) => void)({
      event: { extendedProps: event.extendedProps },
    } as EventClickArg);

    expect(opened?.is_virtual).toBe(true);
    expect(opened?.series_id).toBe('9');
    expect(opened?.occurrence_date).toBe(OCCURRENCE_DATE);
    expect(opened?.id).toBe(`virtual:9:${OCCURRENCE_DATE}`);
  });
});

function fakeGeometry(): TimegridGeometry {
  return {
    ready: () => true,
    minutesAt: () => 9 * 60,
    yForMinutes: () => 100,
    columnAt: () => null,
    columns: () => [],
    beginInteraction: vi.fn(),
    endInteraction: vi.fn(),
    pxPerMinute: () => 1,
  };
}

// jsdom has no PointerEvent constructor; a plain MouseEvent carries the fields useCustomDrag reads.
function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  return new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true }) as PointerEvent;
}

function fakeEl(): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30, x: 0, y: 0, toJSON: () => ({}),
  });
  return el;
}

describe('useCustomDrag drags virtual occurrences (materialize-on-drop)', () => {
  it('begins a drag session for a virtual occurrence past the threshold — the commit path materializes it', () => {
    const onBegin = vi.fn();
    const drag = useCustomDrag({
      geometry: fakeGeometry(),
      fine: ref(false),
      validStartsFor: () => [],
      ready: () => true,
      targetElapsed: () => false,
      onBegin,
      onEnd: vi.fn(),
      onTarget: vi.fn(),
      onCommit: vi.fn(),
    });

    const display = toDisplayAppointment(makeVirtual());
    const el = fakeEl();
    drag.start(display, pointerEvent('pointerdown', 0, 0), el);
    document.dispatchEvent(pointerEvent('pointermove', 50, 50));

    expect(onBegin).toHaveBeenCalledTimes(1);
    expect(onBegin).toHaveBeenCalledWith(display);
  });

  it('control: a real appointment still begins a drag session past the threshold (unchanged behavior)', () => {
    const onBegin = vi.fn();
    const drag = useCustomDrag({
      geometry: fakeGeometry(),
      fine: ref(false),
      validStartsFor: () => [],
      ready: () => true,
      targetElapsed: () => false,
      onBegin,
      onEnd: vi.fn(),
      onTarget: vi.fn(),
      onCommit: vi.fn(),
    });

    const real: Appointment = {
      id: '42', client_user_id: '4', professional_user_id: '2', resource_id: null, service_id: '3',
      starts_at: STARTS_AT, duration_minutes: 30, ends_at: STARTS_AT, state: 'scheduled',
      name: null, description: null, price: '5000.00', override_conflict: false, override_actor_id: null,
      staff_note: null, conflict_ignored: false, created_at: STARTS_AT, updated_at: STARTS_AT,
      series_id: null, occurrence_date: null,
    };
    const el = fakeEl();
    drag.start(real, pointerEvent('pointerdown', 0, 0), el);
    document.dispatchEvent(pointerEvent('pointermove', 50, 50));

    expect(onBegin).toHaveBeenCalledTimes(1);
  });
});

describe('portal AppointmentsView renders a virtual occurrence', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    const auth = useAuthStore();
    auth.user = {
      id: 4, username: 'client', email: null, role: 'Client',
      business_id: 1, is_active: true, must_change_password: false,
    };
  });

  it('shows the recurring badge and no cancel affordance for a virtual occurrence', async () => {
    vi.mocked(listAppointments).mockResolvedValue({ ok: true, data: [makeVirtual()] });

    const wrapper = mount(AppointmentsView, {
      global: { plugins: [makeI18n()], stubs: { CalendarView: true } },
    });
    await flushPromises();

    expect(wrapper.text()).toContain(es.portal.recurringBadge);
    expect(wrapper.text()).not.toContain(es.actions.cancel);
    expect(wrapper.text()).not.toContain(es.portal.withdrawRequest);
  });

  it('a real (non-virtual) upcoming appointment still shows its cancel button', async () => {
    const real: Appointment = {
      id: '42', client_user_id: '4', professional_user_id: '2', resource_id: null, service_id: '3',
      starts_at: STARTS_AT, duration_minutes: 30, ends_at: STARTS_AT, state: 'scheduled',
      name: null, description: null, price: '5000.00', override_conflict: false, override_actor_id: null,
      staff_note: null, conflict_ignored: false, created_at: STARTS_AT, updated_at: STARTS_AT,
      series_id: null, occurrence_date: null,
    };
    vi.mocked(listAppointments).mockResolvedValue({ ok: true, data: [real] });

    const wrapper = mount(AppointmentsView, {
      global: { plugins: [makeI18n()], stubs: { CalendarView: true } },
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain(es.portal.recurringBadge);
    expect(wrapper.text()).toContain(es.actions.cancel);
  });
});
