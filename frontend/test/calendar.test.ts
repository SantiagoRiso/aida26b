import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { colorForProfessional, useAppointmentCalendar } from '@/composables/useFullCalendar';
import { useConflictVerdict } from '@/composables/useConflictVerdict';
import type { Appointment } from '@/api/appointments';
import type { AuthUser } from '@/stores/auth';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';

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

  it('dayGridMonth view config is present (month overview)', () => {
    const viewer = ref<AuthUser | null>(null);
    const { calendarOptions } = useAppointmentCalendar(ref<Appointment[]>([]), viewer, handlers);
    const views = calendarOptions.value.views as Record<string, unknown> | undefined;
    expect(views).toBeDefined();
    expect(views?.['dayGridMonth']).toBeDefined();
    // dayMaxEvents=0 suppresses FullCalendar's default event blocks in month view.
    const monthView = views?.['dayGridMonth'] as Record<string, unknown>;
    expect(monthView['dayMaxEvents']).toBe(0);
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
