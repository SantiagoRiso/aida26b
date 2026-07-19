import { describe, it, expect, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { i18n } from '@/i18n';
import { colorForProfessional, scopeProfessionalOptions, useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useConflictVerdict } from '@/composables/useConflictVerdict';
import type { Appointment } from '@/api/appointments';
import type { AuthUser } from '@/stores/auth';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import type { CalendarOptions, EventMountArg } from '@fullcalendar/core';

describe('colorForProfessional', () => {
  it('returns a stable color for the same id across calls', () => {
    const a = colorForProfessional(3);
    const b = colorForProfessional(3);
    expect(a.bg).toBe(b.bg);
    expect(a.border).toBe(b.border);
  });

  it('returns distinct colors for the first 8 ids', () => {
    const bgs = new Set(Array.from({ length: 8 }, (_, i) => colorForProfessional(i).bg));
    expect(bgs.size).toBe(8);
  });

  it('wraps around after 8 ids', () => {
    // Palette has 8 slots; id 8 wraps back to id 0's color.
    expect(colorForProfessional(8).bg).toBe(colorForProfessional(0).bg);
  });

  it('each color object has bg and border string properties', () => {
    const c = colorForProfessional(1);
    expect(typeof c.bg).toBe('string');
    expect(typeof c.border).toBe('string');
    expect(c.bg.startsWith('#')).toBe(true);
    expect(c.border.startsWith('#')).toBe(true);
  });
});

describe('scopeProfessionalOptions', () => {
  const options = [
    { id: 1, label: 'Dr. A' },
    { id: 2, label: 'Dr. B' },
    { id: 3, label: 'Dr. C' },
  ];

  it('restricts a Professional to their own option', () => {
    const viewer = { id: 2, role: 'Professional' as const };
    expect(scopeProfessionalOptions(options, viewer)).toEqual([{ id: 2, label: 'Dr. B' }]);
  });

  it('matches a Professional when the API serializes ids as strings but the store holds a number', () => {
    // Real data: /api/professionals returns id:"2", auth store holds id:2 — must still match.
    const stringOptions = [
      { id: '1', label: 'Dr. A' },
      { id: '2', label: 'Dr. B' },
      { id: '3', label: 'Dr. C' },
    ];
    const viewer = { id: 2, role: 'Professional' as const };
    expect(scopeProfessionalOptions(stringOptions, viewer)).toEqual([{ id: '2', label: 'Dr. B' }]);
  });

  it('returns an empty list for a Professional with no matching option', () => {
    const viewer = { id: 99, role: 'Professional' as const };
    expect(scopeProfessionalOptions(options, viewer)).toEqual([]);
  });

  it('leaves the full list for Admin', () => {
    expect(scopeProfessionalOptions(options, { id: 1, role: 'Admin' })).toEqual(options);
  });

  it('leaves the full list for Receptionist', () => {
    expect(scopeProfessionalOptions(options, { id: 1, role: 'Receptionist' })).toEqual(options);
  });

  it('leaves the full list when the viewer is null', () => {
    expect(scopeProfessionalOptions(options, null)).toEqual(options);
  });
});

describe('useAppointmentCalendar editable flag', () => {
  const noop = () => {};
  const handlers = {
    onSelect: noop as Parameters<typeof useAppointmentCalendar>[2]['onSelect'],
    onEventClick: noop as Parameters<typeof useAppointmentCalendar>[2]['onEventClick'],
    onEventDrop: noop as Parameters<typeof useAppointmentCalendar>[2]['onEventDrop'],
    onEventResize: noop as Parameters<typeof useAppointmentCalendar>[2]['onEventResize'],
  };

  it('editable is false when viewer role is Client', () => {
    const viewer = ref<AuthUser | null>({
      id: 1, username: 'cli', email: null, role: 'Client',
      business_id: '1', is_active: true, must_change_password: false,
    });
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.editable).toBe(false);
    expect(calendarOptions.value.selectable).toBe(false);
  });

  it('editable is true when viewer role is Admin', () => {
    const viewer = ref<AuthUser | null>({
      id: 2, username: 'admin', email: null, role: 'Admin',
      business_id: '1', is_active: true, must_change_password: false,
    });
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.editable).toBe(true);
  });

  it('editable is true when viewer role is Professional', () => {
    const viewer = ref<AuthUser | null>({
      id: 3, username: 'prof', email: null, role: 'Professional',
      business_id: '1', is_active: true, must_change_password: false,
    });
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.editable).toBe(true);
  });

  it('editable is false when viewer is null', () => {
    const viewer = ref<AuthUser | null>(null);
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.editable).toBe(false);
  });

  it('initialView is timeGridWeek', () => {
    const viewer = ref<AuthUser | null>(null);
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.initialView).toBe('timeGridWeek');
  });

  it('eventDidMount hook is defined', () => {
    const viewer = ref<AuthUser | null>(null);
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(typeof calendarOptions.value.eventDidMount).toBe('function');
  });

  it('dayGridMonth view shows capped event chips with a more-link', () => {
    const viewer = ref<AuthUser | null>(null);
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    const views = calendarOptions.value.views as NonNullable<CalendarOptions['views']> | undefined;
    expect(views).toBeDefined();
    expect(views?.['dayGridMonth']).toBeDefined();
    // Month renders real (block-style) event chips, capped per day so busy days
    // collapse into a "+n más" popover instead of endless stacks.
    const monthView = views?.['dayGridMonth'] as { dayMaxEvents?: number; eventDisplay?: string };
    expect(monthView.dayMaxEvents).toBe(3);
    expect(monthView.eventDisplay).toBe('block');
  });

  it('duration is never resizable on the grid, even for an editable viewer', () => {
    // Duration is changed only through the reschedule form's input — no drag-resize handles.
    const viewer = ref<AuthUser | null>({
      id: 2, username: 'admin', email: null, role: 'Admin',
      business_id: '1', is_active: true, must_change_password: false,
    });
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.editable).toBe(true);
    expect(calendarOptions.value.eventDurationEditable).toBe(false);
    expect(calendarOptions.value.eventStartEditable).toBe(false);
  });
});

describe('useAppointmentCalendar locale follows the app language', () => {
  const viewer = ref<AuthUser | null>(null);
  const handlers = {
    onSelect: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onSelect'],
    onEventClick: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventClick'],
    onEventDrop: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventDrop'],
    onEventResize: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventResize'],
  };

  afterEach(() => {
    i18n.global.locale.value = 'es';
  });

  it('uses the Spanish locale bundle when the app language is es', () => {
    i18n.global.locale.value = 'es';
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect((calendarOptions.value.locale as { code: string }).code).toBe('es');
  });

  it('switches to en when the app language changes, without recreating the calendar', () => {
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    i18n.global.locale.value = 'en';
    // FullCalendar's built-in default is English, addressed by the plain 'en' code.
    expect(calendarOptions.value.locale).toBe('en');
  });
});

describe('useAppointmentCalendar snap grid', () => {
  const viewer = ref<AuthUser | null>({
    id: 2, username: 'admin', email: null, role: 'Admin',
    business_id: '1', is_active: true, must_change_password: false,
  });
  const handlers = {
    onSelect: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onSelect'],
    onEventClick: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventClick'],
    onEventDrop: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventDrop'],
    onEventResize: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventResize'],
  };

  it('uses a plain 30-min base grid with a 10-min snap, independent of any professional lattice', () => {
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    expect(calendarOptions.value.slotDuration).toBe('00:30:00');
    expect(calendarOptions.value.slotLabelInterval).toBe('01:00:00');
    expect(calendarOptions.value.snapDuration).toBe('00:10:00');
  });

  it('wires eventDragStart/eventDragStop when handlers are provided', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { calendarOptions } = useAppointmentCalendar(
      ref<Appointment[]>([]), viewer,
      { ...handlers, onEventDragStart: onStart, onEventDragStop: onStop },
    );
    expect(typeof calendarOptions.value.eventDragStart).toBe('function');
    expect(typeof calendarOptions.value.eventDragStop).toBe('function');
  });
});

describe('useAppointmentCalendar hides non-events', () => {
  const viewer = ref<AuthUser | null>(null);
  const handlers = {
    onSelect: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onSelect'],
    onEventClick: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventClick'],
    onEventDrop: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventDrop'],
    onEventResize: (() => {}) as Parameters<typeof useAppointmentCalendar>[2]['onEventResize'],
  };

  function appt(id: number, state: string, starts = '2026-07-06T10:00:00Z', ends = '2026-07-06T10:30:00Z'): Appointment {
    return {
      id: String(id), client_user_id: '1', professional_user_id: '1', resource_id: null, service_id: '1',
      starts_at: starts, duration_minutes: 30, ends_at: ends, state,
      name: null, description: null, price: '100.00',
      override_conflict: false, override_actor_id: null, staff_note: null, conflict_ignored: false,
      created_at: starts, updated_at: starts, series_id: null, occurrence_date: null,
    };
  }

  it('canceled and rejected never render as events; completed and no_show stay (history/billing)', () => {
    const appointments = ref<Appointment[]>([
      appt(1, 'requested'),
      appt(2, 'scheduled'),
      appt(3, 'completed'),
      appt(4, 'canceled'),
      appt(5, 'no_show'),
      appt(6, 'rejected'),
    ]);
    const { calendarOptions } = useAppointmentCalendar(appointments, viewer, handlers);
    const ids = (calendarOptions.value.events as { id: string }[]).map((e) => e.id);
    expect(ids).toEqual(['1', '2', '3', '5']);
  });

  it('a hidden appointment does not stretch the grid working hours', () => {
    // A canceled 05:00 sobreturno renders nothing, so it must not widen the visible grid either.
    const appointments = ref<Appointment[]>([
      appt(1, 'canceled', '2026-07-06T05:00:00', '2026-07-06T05:30:00'),
    ]);
    const { timeBounds } = useAppointmentCalendar(appointments, viewer, handlers);
    expect(timeBounds.value.min).toBe('07:00:00');
  });

  it('resolves the latest appointment when FullCalendar reuses an event element', () => {
    const original = appt(1, 'scheduled', '2026-07-20T13:50:00', '2026-07-20T14:40:00');
    const appointments = ref<Appointment[]>([original]);
    const onEventPointerDown = vi.fn();
    const { calendarOptions } = useAppointmentCalendar(appointments, viewer, {
      ...handlers,
      onEventPointerDown,
    });
    const element = document.createElement('div');
    const eventDidMount = calendarOptions.value.eventDidMount as (info: EventMountArg) => void;
    eventDidMount({
      el: element,
      event: { extendedProps: { appointment: original } },
    });

    appointments.value = [{ ...original, starts_at: '2026-07-20T14:40:00', ends_at: '2026-07-20T15:30:00' }];
    appointments.value = [{ ...appointments.value[0]!, starts_at: '2026-07-20T15:30:00', ends_at: '2026-07-20T16:20:00' }];
    element.dispatchEvent(new Event('pointerdown'));

    expect(onEventPointerDown).toHaveBeenCalledWith(
      expect.objectContaining({ starts_at: '2026-07-20T15:30:00' }),
      expect.any(Event),
      element,
    );
  });

  it('does not expose staff conflict cues to clients', () => {
    const conflicted = { ...appt(1, 'scheduled'), override_conflict: true, in_conflict: true };
    const appointments = ref<Appointment[]>([conflicted]);
    const clientViewer = ref<AuthUser | null>({ id: 8, role: 'Client', business_id: 1 } as AuthUser);
    const { calendarOptions } = useAppointmentCalendar(appointments, clientViewer, handlers);
    const event = (calendarOptions.value.events as { classNames?: string[] }[])[0]!;
    expect(event.classNames).not.toContain('appt-sobreturno');
    expect(event.classNames).not.toContain('appt-in-conflict');

    const element = document.createElement('div');
    const eventDidMount = calendarOptions.value.eventDidMount as (info: EventMountArg) => void;
    eventDidMount({ el: element, event: { extendedProps: { appointment: conflicted } } });
    expect(element.hasAttribute('data-in-conflict')).toBe(false);
    expect(element.getAttribute('title') ?? '').not.toContain('conflict');
  });
});

describe('useConflictVerdict.describe', () => {
  const { describe: describeConflict } = useConflictVerdict();

  const entity = { kind: 'professional' as const, id: 5, name: 'Dr. Martín' };
  const range = { start: '09:00', end: '09:30' };

  it('returns canOverride=true when verdict.can_override is true', () => {
    const verdict: ConflictVerdict = {
      can_save: false,
      requires_override: true,
      can_override: true,
      conflicts: [],
    };
    expect(describeConflict(verdict).canOverride).toBe(true);
  });

  it('returns canOverride=false when verdict.can_override is false', () => {
    const verdict: ConflictVerdict = {
      can_save: false,
      requires_override: true,
      can_override: false,
      conflicts: [],
    };
    expect(describeConflict(verdict).canOverride).toBe(false);
  });

  it('generates a line for professional_overlap', () => {
    const verdict: ConflictVerdict = {
      can_save: false, requires_override: true, can_override: true,
      conflicts: [{ type: 'professional_overlap', entity, range }],
    };
    const { lines } = describeConflict(verdict);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Dr. Martín');
    expect(lines[0]).toContain('09:00');
  });

  it('generates a line for resource_overlap', () => {
    const resEntity = { kind: 'resource' as const, id: 2, name: 'Sala A' };
    const verdict: ConflictVerdict = {
      can_save: false, requires_override: true, can_override: true,
      conflicts: [{ type: 'resource_overlap', entity: resEntity, range }],
    };
    const { lines } = describeConflict(verdict);
    expect(lines[0]).toContain('Sala A');
  });

  it('generates a line for professional_availability', () => {
    const verdict: ConflictVerdict = {
      can_save: false, requires_override: true, can_override: true,
      conflicts: [{ type: 'professional_availability', entity, range }],
    };
    const { lines } = describeConflict(verdict);
    expect(lines[0]).toContain('Dr. Martín');
  });

  it('generates a line for slot_alignment', () => {
    const verdict: ConflictVerdict = {
      can_save: false, requires_override: true, can_override: true,
      conflicts: [{ type: 'slot_alignment', entity, range }],
    };
    const { lines } = describeConflict(verdict);
    expect(lines[0]).toContain('Dr. Martín');
  });

  it('generates multiple lines for multiple conflicts', () => {
    const verdict: ConflictVerdict = {
      can_save: false, requires_override: true, can_override: true,
      conflicts: [
        { type: 'professional_overlap', entity, range },
        { type: 'professional_availability', entity, range },
      ],
    };
    expect(describeConflict(verdict).lines).toHaveLength(2);
  });

  it('returns empty lines for a clean verdict', () => {
    const verdict: ConflictVerdict = {
      can_save: true, requires_override: false, can_override: false,
      conflicts: [],
    };
    expect(describeConflict(verdict).lines).toHaveLength(0);
  });
});

describe('appointments API ScheduleResult shape', () => {
  it('ScheduleResult discriminant: saved:true means appointment present', () => {
    const mockSaved = { saved: true as const, appointment: {} as Appointment };
    expect(mockSaved.saved).toBe(true);
    expect(mockSaved.appointment).toBeDefined();
  });

  it('ScheduleResult discriminant: saved:false means verdict present', () => {
    const mockConflict = {
      saved: false as const,
      verdict: { can_save: false, requires_override: true, can_override: true, conflicts: [] } as ConflictVerdict,
    };
    expect(mockConflict.saved).toBe(false);
    expect(mockConflict.verdict.requires_override).toBe(true);
  });
});
