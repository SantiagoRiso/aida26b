import { describe, it, expect, afterEach, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import type { CalendarOptions, ToolbarInput } from '@fullcalendar/core';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useScheduleTemplate } from '@/composables/useScheduleTemplate';
import type { TemplateHandlers } from '@/composables/useScheduleTemplate';
import { TEMPLATE_BASE_MONDAY } from '@/composables/scheduleTemplateGrid';
import type { TemplateBlock } from '@/composables/scheduleTemplateGrid';
import type { Appointment } from '@/api/appointments';
import type { AuthUser } from '@/stores/auth';

// jsdom ships no matchMedia at all, so the breakpoint has to be supplied here — and driven, since the
// point of the switch is what happens when the viewport crosses it.
type Listener = (event: MediaQueryListEvent) => void;

function installMatchMedia(wide: boolean) {
  const listeners = new Set<Listener>();
  let matches = wide;
  const stub = vi.fn((query: string) => ({
    media: query,
    get matches() { return matches; },
    addEventListener: (_type: string, fn: Listener) => { listeners.add(fn); },
    removeEventListener: (_type: string, fn: Listener) => { listeners.delete(fn); },
  }));
  vi.stubGlobal('matchMedia', stub);
  return {
    query: () => stub.mock.calls[0]?.[0],
    resizeTo(nextWide: boolean) {
      matches = nextWide;
      for (const fn of listeners) fn({ matches: nextWide } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};
const handlers = {
  onSelect: noop as Parameters<typeof useAppointmentCalendar>[2]['onSelect'],
  onEventClick: noop as Parameters<typeof useAppointmentCalendar>[2]['onEventClick'],
  onEventDrop: noop as Parameters<typeof useAppointmentCalendar>[2]['onEventDrop'],
  onEventResize: noop as Parameters<typeof useAppointmentCalendar>[2]['onEventResize'],
};

function appointmentCalendar() {
  const viewer = ref<AuthUser | null>({
    id: 2, username: 'admin', email: null, role: 'Admin',
    business_id: 1, is_active: true, must_change_password: false,
  });
  return useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
}

function toolbarOf(options: CalendarOptions, key: 'headerToolbar' | 'footerToolbar'): ToolbarInput | false {
  return options[key] as ToolbarInput | false;
}

const VIEW_BUTTONS = 'timeGridDay,timeGridWeek,dayGridMonth';

describe('appointment calendar adapts to the viewport', () => {
  it('starts on the week grid on a wide viewport, with one toolbar row', () => {
    installMatchMedia(true);
    const { calendarOptions } = appointmentCalendar();

    expect(calendarOptions.value.initialView).toBe('timeGridWeek');
    expect(toolbarOf(calendarOptions.value, 'headerToolbar')).toMatchObject({ right: VIEW_BUTTONS });
    expect(toolbarOf(calendarOptions.value, 'footerToolbar')).toBe(false);
  });

  it('starts on a single day below the breakpoint and keeps the view buttons reachable', () => {
    installMatchMedia(false);
    const { calendarOptions } = appointmentCalendar();

    expect(calendarOptions.value.initialView).toBe('timeGridDay');
    const header = toolbarOf(calendarOptions.value, 'headerToolbar');
    // Seven columns and six controls do not share a phone row; the view buttons move below the grid.
    expect(JSON.stringify(header)).not.toContain(VIEW_BUTTONS);
    expect(toolbarOf(calendarOptions.value, 'footerToolbar')).toMatchObject({ center: VIEW_BUTTONS });
  });

  it('uses the same breakpoint as the app shell and reports crossings to the caller', () => {
    const media = installMatchMedia(true);
    const { narrowViewport } = appointmentCalendar();

    expect(media.query()).toBe('(min-width: 768px)');
    expect(narrowViewport.value).toBe(false);

    media.resizeTo(false);
    expect(narrowViewport.value).toBe(true);

    media.resizeTo(true);
    expect(narrowViewport.value).toBe(false);
  });
});

// useScheduleTemplate reads the app locale through useI18n, so it needs a component context.
function mountTemplate() {
  const Harness = defineComponent({
    setup() {
      const blocks = ref<TemplateBlock[]>([]);
      return useScheduleTemplate(blocks, {
        onSelect: noop as TemplateHandlers['onSelect'],
        onEventClick: noop as TemplateHandlers['onEventClick'],
        onEventDrop: noop as TemplateHandlers['onEventDrop'],
        onEventResize: noop as TemplateHandlers['onEventResize'],
        editable: ref(true),
      });
    },
    render: () => null,
  });
  return mount(Harness, {
    global: { plugins: [createI18n({ legacy: false, locale: 'es', messages: { es, en } })] },
  }).vm;
}

describe('schedule template grid adapts to the viewport', () => {
  it('shows the whole week with no toolbar on a wide viewport', () => {
    installMatchMedia(true);
    const vm = mountTemplate();

    expect(vm.calendarOptions.initialView).toBe('timeGridWeek');
    expect(vm.calendarOptions.headerToolbar).toBe(false);
  });

  it('collapses to one weekday with prev/next below the breakpoint', () => {
    installMatchMedia(false);
    const vm = mountTemplate();

    expect(vm.calendarOptions.initialView).toBe('timeGridDay');
    // Without a toolbar the phone would be stuck on whichever weekday rendered first.
    expect(vm.calendarOptions.headerToolbar).toMatchObject({ left: 'prev', right: 'next' });
  });

  it('fences navigation to the anchor week so a created block stays placeable', () => {
    installMatchMedia(false);
    const vm = mountTemplate();

    expect(vm.calendarOptions.validRange).toEqual({ start: TEMPLATE_BASE_MONDAY, end: '2024-01-08' });
  });
});
