import { computed, type Ref } from 'vue';
import type { CalendarOptions, DateSelectArg, EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import esLocale from '@fullcalendar/core/locales/es';
import { useI18n } from 'vue-i18n';
import { TEMPLATE_BASE_MONDAY, blockToEvent, type TemplateBlock } from './scheduleTemplateGrid';

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
): { calendarOptions: Ref<CalendarOptions> } {
  const { locale } = useI18n();
  const calendarOptions = computed<CalendarOptions>(() => ({
    plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
    initialView: 'timeGridWeek',
    initialDate: TEMPLATE_BASE_MONDAY,
    headerToolbar: false,
    dayHeaderFormat: { weekday: 'long' },
    locale: locale.value === 'en' ? 'en' : esLocale,
    firstDay: 1,
    allDaySlot: false,
    slotMinTime: '06:00:00',
    slotMaxTime: '23:00:00',
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
    events: blocks.value.map(blockToEvent) as EventInput[],
    // Stamp the block id on the rendered element so the view's delegated pointerdown can pick it up.
    eventDidMount: (arg) => { arg.el.dataset.blockId = arg.event.id; },
    select: handlers.onSelect,
    eventClick: handlers.onEventClick,
    eventDrop: handlers.onEventDrop,
    eventResize: handlers.onEventResize,
  }));
  return { calendarOptions };
}
