import { computed } from 'vue';
import type { Ref } from 'vue';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type {
  CalendarOptions,
  EventInput,
  EventDropArg,
  DateSelectArg,
  EventClickArg,
  EventMountArg,
  DayCellMountArg,
} from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import type { Appointment } from '@/api/appointments';
import type { AuthUser } from '@/stores/auth';

// 8-hue palette for multi-professional color coding (per-professional, not per-state).
// Colors assigned deterministically by professional id so they are stable across sessions.
const PROF_PALETTE = [
  { bg: '#3B82F6', border: '#2563EB' }, // blue-500 / blue-600
  { bg: '#8B5CF6', border: '#7C3AED' }, // violet-500 / violet-600
  { bg: '#10B981', border: '#059669' }, // emerald-500 / emerald-600
  { bg: '#F59E0B', border: '#D97706' }, // amber-500 / amber-600
  { bg: '#F43F5E', border: '#E11D48' }, // rose-500 / rose-600
  { bg: '#06B6D4', border: '#0891B2' }, // cyan-500 / cyan-600
  { bg: '#D946EF', border: '#C026D3' }, // fuchsia-500 / fuchsia-600
  { bg: '#84CC16', border: '#65A30D' }, // lime-500 / lime-600
] as const;

export function colorForProfessional(professionalId: number): { bg: string; border: string } {
  return PROF_PALETTE[professionalId % PROF_PALETTE.length];
}

function apptToEvent(appt: Appointment): EventInput {
  const colors = colorForProfessional(appt.professional_user_id);
  return {
    id: String(appt.id),
    title: appt.name ?? `Turno #${appt.id}`,
    start: appt.starts_at,
    end: appt.ends_at,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    textColor: '#ffffff',
    classNames: [`appt-state-${appt.state}`],
    extendedProps: { appointment: appt },
  };
}

export interface CalendarHandlers {
  onSelect: (arg: DateSelectArg) => void;
  onEventClick: (arg: EventClickArg) => void;
  onEventDrop: (arg: EventDropArg) => void;
  onEventResize: (arg: EventResizeDoneArg) => void;
}

export function useAppointmentCalendar(
  appointments: Ref<Appointment[]>,
  viewer: Ref<AuthUser | null>,
  handlers: CalendarHandlers,
): { calendarOptions: Ref<CalendarOptions> } {
  // Only authenticated non-Client viewers may drag/resize — null viewer is treated as read-only.
  const editable = computed(() => !!viewer.value && viewer.value.role !== 'Client');

  // Per-day appointment counts for the month "dots/counts" overview.
  function dayCountMap(): Map<string, number> {
    const map = new Map<string, number>();
    for (const appt of appointments.value) {
      const day = appt.starts_at.slice(0, 10);
      map.set(day, (map.get(day) ?? 0) + 1);
    }
    return map;
  }

  const calendarOptions = computed<CalendarOptions>(() => ({
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
    initialView: 'timeGridWeek',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'timeGridDay,timeGridWeek,dayGridMonth',
    },
    locale: 'es',
    firstDay: 1,
    allDaySlot: false,
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    height: 'auto',

    selectable: editable.value,
    editable: editable.value,
    eventDurationEditable: editable.value,

    events: appointments.value.map(apptToEvent),

    select: handlers.onSelect,
    eventClick: handlers.onEventClick,
    eventDrop: handlers.onEventDrop,
    eventResize: handlers.onEventResize,

    // Stamp each rendered event element with a stable test id so Playwright
    // can target by attribute rather than by coordinates or visible text.
    eventDidMount: (info: EventMountArg) => {
      const appt = info.event.extendedProps.appointment as Appointment | undefined;
      if (appt) {
        info.el.setAttribute('data-testid', `appt-${appt.id}`);
        info.el.setAttribute('data-appt-state', appt.state);
      }
    },

    // Month view: suppress per-appointment blocks; instead show a count badge via
    // dayCellContent so the month is a lightweight overview (dots/counts), not stacked blocks.
    views: {
      dayGridMonth: {
        dayMaxEvents: 0,
        dayCellContent: (arg: DayCellMountArg) => {
          const dateStr = arg.date.toISOString().slice(0, 10);
          const count = dayCountMap().get(dateStr) ?? 0;
          const dayNum = arg.date.getDate();
          return {
            html: `<div class="fc-daygrid-day-number">${dayNum}</div>${count > 0 ? `<div class="fc-day-count-badge">${count}</div>` : ''}`,
          };
        },
      },
    },
  }));

  return { calendarOptions };
}
