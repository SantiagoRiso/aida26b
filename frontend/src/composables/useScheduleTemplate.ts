import { computed, type Ref } from 'vue';
import type { CalendarOptions, DateSelectArg, EventClickArg, EventDropArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import esLocale from '@fullcalendar/core/locales/es';
import { useI18n } from 'vue-i18n';
import { TEMPLATE_BASE_MONDAY, blockToEvent, type TemplateBlock } from './scheduleTemplateGrid';
import { DAY_MIN_MINUTES, DAY_MAX_MINUTES } from './templateBlockPlacement';
import { useNarrowViewport } from './useViewport';
import { toHHMM } from '@shared/ssot/domain';

// The template is one synthetic week. Navigation is fenced to it so a block created on the phone's
// single-day view can never land on a date the weekday↔date mapping renders somewhere else.
const TEMPLATE_WEEK_END = (() => {
  const [y, m, d] = TEMPLATE_BASE_MONDAY.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;
})();

export interface TemplateHandlers {
  onSelect: (arg: DateSelectArg) => void;
  onEventClick: (arg: EventClickArg) => void;
  onEventDrop: (arg: EventDropArg) => void;
  onEventResize: (arg: EventResizeDoneArg) => void;
  editable: Ref<boolean>;
}

export function useScheduleTemplate(
  blocks: Ref<TemplateBlock[]>,
  handlers: TemplateHandlers,
): { calendarOptions: Ref<CalendarOptions>; narrowViewport: Ref<boolean> } {
  const { locale } = useI18n();
  // A phone shows one weekday at a time, with prev/next as the only way between them — the seven
  // columns are unusable at that width and this grid has no toolbar to switch views from.
  const narrowViewport = useNarrowViewport();
  const calendarOptions = computed<CalendarOptions>(() => ({
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
    initialView: narrowViewport.value ? 'timeGridDay' : 'timeGridWeek',
    initialDate: TEMPLATE_BASE_MONDAY,
    validRange: { start: TEMPLATE_BASE_MONDAY, end: TEMPLATE_WEEK_END },
    headerToolbar: narrowViewport.value ? { left: 'prev', center: 'title', right: 'next' } : false,
    // The anchor week's dates are an implementation detail; only the weekday means anything.
    titleFormat: { weekday: 'long' },
    dayHeaderFormat: { weekday: 'long' },
    locale: locale.value === 'en' ? 'en' : esLocale,
    firstDay: 1,
    allDaySlot: false,
    // Bounds live in templateBlockPlacement (DAY_MIN_MINUTES/DAY_MAX_MINUTES) — the drag math's source
    // of truth for the visible day range; this derives FC's 'HH:MM:00' strings from it.
    slotMinTime: `${toHHMM(DAY_MIN_MINUTES)}:00`,
    slotMaxTime: `${toHHMM(DAY_MAX_MINUTES)}:00`,
    slotDuration: '00:30:00',
    snapDuration: '00:01:00',
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    height: 'auto',
    expandRows: true,
    nowIndicator: false,
    selectable: handlers.editable.value,
    selectMirror: true,
    // Move/resize is driven by useTemplateBlockDrag (a custom ghost that snaps flush to neighbouring
    // blocks mid-drag, which FC's lattice snap can't do), so native event editing stays off. Drag-to-
    // create is still native — selectable above — and snaps on release.
    editable: false,
    selectOverlap: false,
    events: blocks.value.map(blockToEvent),
    // Stamp the block id on the rendered element so the view's delegated pointerdown can pick it up.
    eventDidMount: (arg) => { arg.el.dataset.blockId = arg.event.id; },
    select: handlers.onSelect,
    eventClick: handlers.onEventClick,
    eventDrop: handlers.onEventDrop,
    eventResize: handlers.onEventResize,
  }));
  return { calendarOptions, narrowViewport };
}
