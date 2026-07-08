import { computed } from 'vue';
import type { Ref } from 'vue';
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
  // Hover tooltip explaining what the block is (who/what/state).
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
  const timeBounds = computed(() => {
    let minHour = 7;
    let maxHour = 21;
    for (const appt of appointments.value) {
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
    locale: esLocale,
    firstDay: 1,
    allDaySlot: false,
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    height: 'auto',
    expandRows: true,
    nowIndicator: true,
    slotMinTime: snap.value.slotMinTime,
    slotMaxTime: timeBounds.value.max,
    slotDuration: snap.value.slotDuration,
    slotLabelInterval: snap.value.slotLabelInterval,
    // Day/week header dates and month day numbers link into the day view.
    navLinks: true,
    // Month chips render as solid colored blocks (professional hue), not dot+text rows.
    eventDisplay: 'block',
    // Overlapping events render side by side, not stacked over each other.
    slotEventOverlap: false,
    // Drag preview snaps to the professional's slot lattice (see `snap`); Shift → 5-min.
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
    // slots mid-drag — FC's delta-based move can't. Resize stays native.
    eventStartEditable: false,
    eventDurationEditable: editable.value,

    events: appointments.value.map((a) => apptToEvent(a, decorators)),

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
        // Entry point for the custom drag (see onEventPointerDown).
        if (handlers.onEventPointerDown) {
          info.el.addEventListener('pointerdown', (ev) =>
            handlers.onEventPointerDown!(appt, ev as PointerEvent, info.el),
          );
        }
      }
    },

    // Month view: real (compact) event chips capped per day, with a "+n más" popover.
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
