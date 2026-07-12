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
import { snapConfig } from '@/composables/calendarGrid';
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

// When a single professional is in view we know their slot lattice, so the drag snaps onto real
// slots: snapDuration is the GCD of their slot starts (+ the row size), which lands every grid
// line on a real slot. `fine` (sobreturno mode) overrides to 5-min sub-steps. Mixed 'Todos'
// view has no shared lattice → null → a plain 30-min grid with fine 5-min snapping; the drop
// handler still resolves against the dragged professional's real slots.
export interface DragTuning {
  fine: Ref<boolean>;
  slotStartsMinutes: Ref<number[] | null>;
  slotMinutes: Ref<number | null>;
}

function hmsToMinutes(hms: string): number {
  const [h, m] = hms.split(':').map(Number);
  return h * 60 + m;
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
  dragTuning?: DragTuning,
): { calendarOptions: Ref<CalendarOptions>; timeBounds: Ref<{ min: string; max: string }> } {
  // Only authenticated non-Client viewers may drag/resize — null viewer is read-only.
  const editable = computed(() => !!viewer.value && viewer.value.role !== 'Client');

  const visibleAppointments = computed(() => calendarVisibleAppointments(appointments.value));

  // Follow the app language: es uses the imported locale bundle; en is FullCalendar's built-in default.
  // Read the shared i18n instance's locale ref (the ui store's single source of truth) rather than
  // useI18n() so the composable works outside a component setup context too.
  const locale = i18n.global.locale;

  // Snap the live drag preview to the professional's slot lattice: grid rows ARE the slots
  // (row height + labels = the step) and slotMinTime aligns so rows sit on real slot starts,
  // so a drag jumps slot-to-slot. Sobreturno mode → 5-min sub-steps. No lattice (mixed
  // 'Todos' view) → a plain 30-min grid with a coarse snap; the drop handler still lands the
  // block on the real slot.
  const snap = computed(() =>
    snapConfig(
      dragTuning?.slotStartsMinutes.value ?? null,
      dragTuning?.slotMinutes.value ?? null,
      hmsToMinutes(timeBounds.value.min),
      dragTuning?.fine.value ?? false,
    ),
  );

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

  // Round the grid's bottom UP to the professional's slot lattice. Otherwise the last lattice row
  // (e.g. 20:40–21:30 on a 50-min grid) is only partly valid time below a non-aligned slotMaxTime
  // (21:00), leaving a dead sub-row the availability overlay can't cover.
  const slotMaxTime = computed(() => {
    const gran = hmsToMinutes(snap.value.slotDuration);
    const origin = hmsToMinutes(snap.value.slotMinTime);
    const rawMax = hmsToMinutes(timeBounds.value.max);
    if (!gran || rawMax <= origin) return timeBounds.value.max;
    const aligned = Math.min(origin + Math.ceil((rawMax - origin) / gran) * gran, 24 * 60);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(Math.floor(aligned / 60))}:${pad(aligned % 60)}:00`;
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
    slotMinTime: snap.value.slotMinTime,
    slotMaxTime: slotMaxTime.value,
    slotDuration: snap.value.slotDuration,
    slotLabelInterval: snap.value.slotLabelInterval,
    navLinks: true,
    eventDisplay: 'block',
    slotEventOverlap: false,
    // Drag preview snaps to the professional's slot lattice (see `snap`); sobreturno mode uses 5-min sub-steps.
    // For mixed views the drop handler still lands the block on the real slot as a backstop.
    snapDuration: snap.value.snapDuration,

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
