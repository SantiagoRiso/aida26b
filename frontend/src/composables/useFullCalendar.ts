import { computed } from 'vue';
import type { Ref } from 'vue';
import { i18n } from '@/i18n';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import esLocale from '@fullcalendar/core/locales/es';
import type {
  CalendarOptions,
  EventInput,
  EventDropArg,
  DateSelectArg,
  EventClickArg,
  EventMountArg,
} from '@fullcalendar/core';
import type {
  EventResizeDoneArg,
  EventDragStartArg,
  EventDragStopArg,
} from '@fullcalendar/interaction';
import type { Appointment } from '@/api/appointments';
import type { AuthUser } from '@/stores/auth';
import { VOID_APPOINTMENT_STATES } from '@shared/ssot/domain';
import { classifyException, type ExceptionRow } from '@/composables/scheduleExceptions';

// 8-hue palette for multi-professional color coding (per-professional, not per-state).
// Colors assigned deterministically by professional id so they are stable across sessions.
const PROF_PALETTE = [
  { bg: '#3B82F6', border: '#2563EB' },
  { bg: '#8B5CF6', border: '#7C3AED' },
  { bg: '#10B981', border: '#059669' },
  { bg: '#F59E0B', border: '#D97706' },
  { bg: '#F43F5E', border: '#E11D48' },
  { bg: '#06B6D4', border: '#0891B2' },
  { bg: '#D946EF', border: '#C026D3' },
  { bg: '#84CC16', border: '#65A30D' },
] as const;

export function colorForProfessional(professionalId: number): { bg: string; border: string } {
  return PROF_PALETTE[professionalId % PROF_PALETTE.length];
}

// A plain professional manages only their own calendar, so the professional filter
// must not expose other professionals' options. Other roles see the full list.
export function scopeProfessionalOptions<T extends { id: number | string }>(
  options: T[],
  viewer: Pick<AuthUser, 'id' | 'role'> | null | undefined,
): T[] {
  if (viewer?.role === 'Professional') {
    // The CRUD API serializes ids as strings while the auth store holds a number, so compare
    // as strings — a strict === would always miss and hide the professional's own calendar.
    return options.filter((o) => String(o.id) === String(viewer.id));
  }
  return options;
}

// Canceled bookings and rejected requests no longer occupy time, so they never render as
// calendar events (they stay reachable through the lists). Completed and no_show remain
// visible: they happened, and matter for history and billing.
const HIDDEN_CALENDAR_STATES = new Set<string>(VOID_APPOINTMENT_STATES);

export function calendarVisibleAppointments(appointments: Appointment[]): Appointment[] {
  return appointments.filter((a) => !HIDDEN_CALENDAR_STATES.has(a.state));
}

export interface CalendarHandlers {
  onSelect: (arg: DateSelectArg) => void;
  onEventClick: (arg: EventClickArg) => void;
  onEventDrop: (arg: EventDropArg) => void;
  onEventResize: (arg: EventResizeDoneArg) => void;
  onEventDragStart?: (arg: EventDragStartArg) => void;
  onEventDragStop?: (arg: EventDragStopArg) => void;
  // Fires on pointerdown on an event. The staff view uses this to start its own drag (useCustomDrag);
  // native FC event-move is disabled so the two can't fight.
  onEventPointerDown?: (appt: Appointment, ev: PointerEvent, el: HTMLElement) => void;
}

export interface CalendarDecorators {
  // Untitled events fall back to this (e.g. client name for staff, professional for
  // clients) before the last-resort "Turno #id".
  fallbackTitle?: (appt: Appointment) => string | null;
  tooltip?: (appt: Appointment) => string;
}

function apptToEvent(appt: Appointment, decorators?: CalendarDecorators): EventInput {
  const colors = colorForProfessional(appt.professional_user_id);
  return {
    id: String(appt.id),
    title: appt.name ?? decorators?.fallbackTitle?.(appt) ?? `Turno #${appt.id}`,
    start: appt.starts_at,
    end: appt.ends_at,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    textColor: '#ffffff',
    classNames: [`appt-state-${appt.state}`],
    extendedProps: { appointment: appt },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function useAppointmentCalendar(
  appointments: Ref<Appointment[]>,
  viewer: Ref<AuthUser | null>,
  handlers: CalendarHandlers,
  decorators?: CalendarDecorators,
): { calendarOptions: Ref<CalendarOptions>; timeBounds: Ref<{ min: string; max: string }> } {
  // Only authenticated non-Client viewers may drag/resize — null viewer is read-only.
  const editable = computed(() => !!viewer.value && viewer.value.role !== 'Client');

  const visibleAppointments = computed(() => calendarVisibleAppointments(appointments.value));

  // Follow the app language: es uses the imported locale bundle; en is FullCalendar's built-in default.
  // Read the shared i18n instance's locale ref (the ui store's single source of truth) rather than
  // useI18n() so the composable works outside a component setup context too.
  const locale = i18n.global.locale;

  // Trim the grid to working hours instead of rendering a mostly-empty 24h column,
  // widening it if any loaded appointment (e.g. a sobreturno) falls outside.
  // Only rendered appointments count — a hidden canceled sobreturno must not stretch the grid.
  const timeBounds = computed(() => {
    let minHour = 7;
    let maxHour = 21;
    for (const appt of visibleAppointments.value) {
      const start = new Date(appt.starts_at);
      const end = new Date(appt.ends_at);
      if (start.getHours() < minHour) minHour = start.getHours();
      const endEdge = end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
      if (endEdge > maxHour) maxHour = endEdge;
    }
    const pad = (n: number) => String(Math.min(Math.max(n, 0), 24)).padStart(2, '0');
    return { min: `${pad(minHour)}:00:00`, max: `${pad(maxHour)}:00:00` };
  });

  const calendarOptions = computed<CalendarOptions>(() => ({
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
    initialView: 'timeGridWeek',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'timeGridDay,timeGridWeek,dayGridMonth',
    },
    locale: locale.value === 'en' ? 'en' : esLocale,
    firstDay: 1,
    allDaySlot: false,
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    height: 'auto',
    expandRows: true,
    nowIndicator: true,
    // A plain regular scale from working-start to working-end — a clean 30-min base with hourly labels,
    // independent of the professional's blocks so it never looks busy or chases an off-phase block. The
    // real schedule slots are drawn on top as a dotted overlay (see the staff view); the fine 10-min
    // precision lives in the drag snap, not in the visible grid.
    slotMinTime: timeBounds.value.min,
    slotMaxTime: timeBounds.value.max,
    slotDuration: '00:30:00',
    slotLabelInterval: '01:00:00',
    navLinks: true,
    eventDisplay: 'block',
    slotEventOverlap: false,
    // 10-min snap so a turno can be nudged off the slot lattice (into gaps / sobreturno) in fine steps.
    snapDuration: '00:10:00',

    // Compact one-line-first rendering so short events show "HH:MM Título" instead of
    // clipping the time and title mid-letter.
    eventContent: (arg) => ({
      html: `<div class="fc-ev-compact"><span class="fc-ev-time">${arg.timeText.split(' - ')[0] ?? ''}</span> <span class="fc-ev-title">${escapeHtml(arg.event.title)}</span></div>`,
    }),

    selectable: editable.value,
    editable: editable.value,
    // The staff view drives event moves itself (useCustomDrag) so a sobreturno can snap onto real
    // slots mid-drag — FC's delta-based move can't. Duration is changed through the reschedule
    // form's input, never by dragging a resize handle on the grid.
    eventStartEditable: false,
    eventDurationEditable: false,

    events: visibleAppointments.value.map((a) => apptToEvent(a, decorators)),

    select: handlers.onSelect,
    eventClick: handlers.onEventClick,
    eventDrop: handlers.onEventDrop,
    eventResize: handlers.onEventResize,
    eventDragStart: handlers.onEventDragStart,
    eventDragStop: handlers.onEventDragStop,

    // Stamp each rendered event element with a stable test id so Playwright
    // can target by attribute rather than by coordinates or visible text.
    eventDidMount: (info: EventMountArg) => {
      const appt = info.event.extendedProps.appointment as Appointment | undefined;
      if (appt) {
        info.el.setAttribute('data-testid', `appt-${appt.id}`);
        info.el.setAttribute('data-appt-state', appt.state);
        const tip = decorators?.tooltip?.(appt);
        if (tip) info.el.setAttribute('title', tip);
        if (handlers.onEventPointerDown) {
          info.el.addEventListener('pointerdown', (ev) =>
            handlers.onEventPointerDown!(appt, ev as PointerEvent, info.el),
          );
        }
        return;
      }
      // Background exception overlays aren't clickable/hoverable via eventContent (FullCalendar
      // never renders content for display:'background' events), so the reason surfaces as a
      // native browser tooltip instead.
      const exception = info.event.extendedProps.exception as ExceptionRow | undefined;
      if (exception) {
        const kind = classifyException(exception);
        const tip = exception.reason || i18n.global.t(`exception.kind.${kind}`);
        info.el.setAttribute('title', tip);
        info.el.setAttribute('data-testid', `exception-${exception.id}`);
      }
    },

    views: {
      dayGridMonth: {
        dayMaxEvents: 3,
        eventDisplay: 'block',
        navLinkDayClick: 'timeGridDay',
        // Month moves are day-granularity and have no slot lattice, so native move is fine here;
        // only the timegrid needs the custom drag.
        eventStartEditable: editable.value,
      },
    },
  }));

  return { calendarOptions, timeBounds };
}
