import { describe, it, expect } from 'vitest';
import { structure } from '../../shared/src/ssot/structure';
import { validateFullObject } from '../../shared/src/validation/validate';
import {
  getSchedulable,
  isBusinessScoped,
  isProtected,
  getCrudPolicy,
  getSoftDeletePolicy,
} from '../../shared/src/utils/utils';
import {
  WEEKDAYS,
  validateWeeklySchedule,
  computeDailyAvailability,
  computeDailySlots,
  resolveBooking,
  evaluateConflicts,
  detectOverlap,
} from '../../shared/src/ssot/domain';
import type { BookedAppointment } from '../../shared/src/ssot/domain';
import type {
  TableStructure,
  SchedulableCapability,
  ColumnDef,
  LocalizedText,
} from '../../shared/src/types/types';

function isLocalized(text: unknown): text is LocalizedText {
  return (
    !!text &&
    typeof text === 'object' &&
    typeof (text as any).es === 'string' &&
    typeof (text as any).en === 'string'
  );
}

const tableKeys = Object.keys(structure.tables);

describe('SSOT metadata contract', () => {
  it('accepts rich scheduler metadata: crud policy, soft-delete, status, schedulable capability', () => {
    const schedulable: SchedulableCapability = {
      calendarLabel: { es: 'Profesional', en: 'Professional' },
      identityField: 'id',
      displayField: 'display_name',
      ownerForeignKey: 'professional_id',
      availability: { weeklySource: 'schedules', exceptionSource: 'schedule_exceptions' },
      conflict: { overridable: true },
      rules: { availability: 'computeDailyAvailability', conflict: 'detectOverlap' },
    };

    const sample: TableStructure = {
      columns: {
        id: { type: 'string', label: { es: 'ID', en: 'ID' }, editable: false },
        name: {
          type: 'string',
          label: { es: 'Nombre', en: 'Name' },
          filterable: true,
          sortable: true,
          validator: { required: true },
        },
        status: { type: 'string', label: { es: 'Estado', en: 'Status' } },
      },
      pk: 'id',
      uiName: { es: 'Ejemplo', en: 'Example' },
      businessScoped: true,
      protected: false,
      crud: { create: true, read: true, update: true, delete: true },
      softDelete: { deletedAtColumn: 'deleted_at', deletedByColumn: 'deleted_by_user_id' },
      status: {
        column: 'status',
        values: [{ value: 'active', label: { es: 'Activo', en: 'Active' } }],
      },
      schedulable,
    };

    expect(sample.schedulable?.ownerForeignKey).toBe('professional_id');
    expect(sample.softDelete?.deletedAtColumn).toBe('deleted_at');
    expect(sample.crud?.delete).toBe(true);
    expect(sample.columns.name.filterable).toBe(true);
  });

  it('uses { es, en } localized labels everywhere in the live SSOT', () => {
    for (const [tableName, table] of Object.entries(structure.tables)) {
      expect(isLocalized(table.uiName), `${tableName}.uiName`).toBe(true);
      for (const [colName, col] of Object.entries(table.columns as Record<string, ColumnDef>)) {
        if (col.label !== undefined) {
          expect(isLocalized(col.label), `${tableName}.${colName}.label`).toBe(true);
        }
        for (const opt of col.options ?? []) {
          expect(isLocalized(opt.label), `${tableName}.${colName} option`).toBe(true);
        }
      }
    }
  });
});

describe('scheduler entity set (academic surface removed)', () => {
  const EXPECTED = [
    'businesses',
    'users',
    'sessions',
    'clients',
    'professionals',
    'resources',
    'services',
    'client_professional_services',
    'schedules',
    'schedule_exceptions',
    'appointments',
    'ledger_entries',
    'audit_events',
    'calendar_grants',
  ];

  it('declares exactly the scheduler entities the migration creates (no extras)', () => {
    expect(new Set(tableKeys)).toEqual(new Set(EXPECTED));
  });

  it('does not declare dropped redesign entities', () => {
    for (const dropped of [
      'schedulables',
      'professional_services',
      'availability_blocks',
      'availability_exceptions',
      'appointment_resources',
    ]) {
      expect(tableKeys).not.toContain(dropped);
    }
  });
});

describe('professionals and resources are independent, each schedulable', () => {
  it('each has its own single-column PK', () => {
    expect(structure.tables.professionals.pk).toBe('id');
    expect(structure.tables.resources.pk).toBe('id');
  });

  it('both expose a schedulable capability pointing at their own owner FK', () => {
    expect(getSchedulable('professionals')?.ownerForeignKey).toBe('professional_user_id');
    expect(getSchedulable('resources')?.ownerForeignKey).toBe('resource_id');
    expect(getSchedulable('professionals')?.displayField).toBe('display_name');
    expect(getSchedulable('resources')?.displayField).toBe('name');
  });
});

describe('ordinary vs protected CRUD boundaries', () => {
  const ordinary = [
    'clients',
    'professionals',
    'resources',
    'services',
    'client_professional_services',
    'schedules',
    'schedule_exceptions',
  ];
  const protectedTables = [
    'businesses',
    'users',
    'sessions',
    'appointments',
    'ledger_entries',
    'audit_events',
    'calendar_grants',
  ];

  it('ordinary configuration entities are generic-CRUD eligible and not protected', () => {
    for (const t of ordinary) {
      expect(isProtected(t as any), `${t} protected`).toBe(false);
      expect(getCrudPolicy(t as any), `${t} crud`).toBeTruthy();
    }
  });

  it('workflow/identity entities are protected and not generic-CRUD eligible', () => {
    for (const t of protectedTables) {
      expect(isProtected(t as any), `${t} protected`).toBe(true);
      expect(getCrudPolicy(t as any), `${t} crud`).toBeUndefined();
    }
  });

  it('withholds generic delete where the schema grants no DELETE', () => {
    expect(getCrudPolicy('client_professional_services')?.delete).toBe(false);
    expect(getCrudPolicy('schedules')?.delete).toBe(false);
    expect(getCrudPolicy('schedule_exceptions')?.delete).toBe(true);
  });
});

describe('soft-delete and status metadata', () => {
  it('marks the referenced core records as soft-deletable', () => {
    for (const t of ['clients', 'professionals', 'resources', 'services', 'users']) {
      expect(getSoftDeletePolicy(t as any)?.deletedAtColumn, t).toBe('deleted_at');
    }
  });

  it('does not soft-delete records that have no deleted_at column', () => {
    for (const t of ['client_professional_services', 'schedules', 'schedule_exceptions']) {
      expect(getSoftDeletePolicy(t as any), t).toBeUndefined();
    }
  });

  it('declares status metadata for appointment state, ledger type and audit outcome', () => {
    expect((structure.tables.appointments as TableStructure).status?.column).toBe('state');
    expect((structure.tables.ledger_entries as TableStructure).status?.column).toBe('entry_type');
    expect((structure.tables.audit_events as TableStructure).status?.column).toBe('outcome');
  });
});

describe('appointment shape', () => {
  const cols = structure.tables.appointments.columns as Record<string, ColumnDef>;

  it('uses a single nullable resource_id, starts_at/duration_minutes/ends_at, state and price', () => {
    expect(cols.resource_id).toBeTruthy();
    expect(cols.resource_id.validator?.nullable).toBe(true);
    expect(cols.starts_at).toBeTruthy();
    expect(cols.duration_minutes).toBeTruthy();
    expect(cols.ends_at).toBeTruthy();
    expect(cols.state).toBeTruthy();
    expect(cols.price).toBeTruthy();
  });

  it('names the booked price `price`, not `price_snapshot`', () => {
    expect(cols.price).toBeTruthy();
    expect(cols.price_snapshot).toBeUndefined();
  });
});

describe('business scoping: only direct owners carry business_id', () => {
  it('direct owners are business-scoped (resources/services/audit_events carry business_id directly)', () => {
    for (const t of ['resources', 'services', 'audit_events']) {
      expect(isBusinessScoped(t as any), t).toBe(true);
    }
    expect(isBusinessScoped('users' as any)).toBe(true);
  });

  it('clients and professionals are businessScoped (backed by auth.users which carries business_id)', () => {
    expect(isBusinessScoped('clients' as any)).toBe(true);
    expect(isBusinessScoped('professionals' as any)).toBe(true);
  });

  it('derived-scope entities are not business-scoped', () => {
    for (const t of [
      'client_professional_services',
      'schedules',
      'schedule_exceptions',
      'appointments',
      'ledger_entries',
      'calendar_grants',
    ]) {
      expect(isBusinessScoped(t as any), t).toBe(false);
    }
  });
});

describe('field-level validation', () => {
  it('returns a per-field error map keyed by field name', () => {
    const result = validateFullObject('clients', {});
    expect('errors' in result).toBe(true);
    if ('fields' in result) {
      expect(result.fields).toBeTypeOf('object');
      expect(result.fields.display_name).toMatch(/required/);
    } else {
      throw new Error('expected a validation failure with a fields map');
    }
  });

  it('reports an invalid field by name, not as an opaque string list', () => {
    const result = validateFullObject('clients', {
      display_name: 'Ana',
      email: 'not-an-email',
      phone: '123',
      notes: 'x',
    });
    expect('fields' in result).toBe(true);
    if ('fields' in result) {
      expect(result.fields.email).toMatch(/email/i);
    }
  });
});

describe('pure scheduling rules (availability is computed, not stored)', () => {
  const everyDay = (iv: { start: string; end: string }) =>
    Object.fromEntries(WEEKDAYS.map((d) => [d, [iv]]));

  it('validates the weekly JSON shape', () => {
    expect(
      validateWeeklySchedule({ mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] }).ok,
    ).toBe(true);
    expect(validateWeeklySchedule({ funday: [] }).ok).toBe(false);
    expect(
      validateWeeklySchedule({ mon: [{ start: '9:00', end: '12:00', granularity_minutes: 15 }] }).ok,
    ).toBe(false);
    expect(
      validateWeeklySchedule({
        mon: [
          { start: '09:00', end: '12:00', granularity_minutes: 15 },
          { start: '11:00', end: '13:00', granularity_minutes: 15 },
        ],
      }).ok,
    ).toBe(false);
  });

  it('returns the weekly base when there are no exceptions or bookings', () => {
    const free = computeDailyAvailability({
      date: '2026-06-29',
      weekly: everyDay({ start: '09:00', end: '17:00' }),
    });
    expect(free).toEqual([{ start: '09:00', end: '17:00' }]);
  });

  it('blocks the whole day on a full-day unavailable exception', () => {
    const free = computeDailyAvailability({
      date: '2026-06-29',
      weekly: everyDay({ start: '09:00', end: '17:00' }),
      exceptions: [{ is_unavailable: true }],
    });
    expect(free).toEqual([]);
  });

  it('subtracts partial unavailable exceptions and booked appointments', () => {
    const free = computeDailyAvailability({
      date: '2026-06-29',
      weekly: everyDay({ start: '09:00', end: '17:00' }),
      exceptions: [{ is_unavailable: true, start_time: '12:00', end_time: '13:00' }],
      booked: [{ start: '10:00', end: '11:00' }],
    });
    expect(free).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '11:00', end: '12:00' },
      { start: '13:00', end: '17:00' },
    ]);
  });

  it('widens availability with an "available" exception', () => {
    const free = computeDailyAvailability({
      date: '2026-06-29',
      weekly: everyDay({ start: '09:00', end: '12:00' }),
      exceptions: [{ is_unavailable: false, start_time: '13:00', end_time: '15:00' }],
    });
    expect(free).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '15:00' },
    ]);
  });

  it('detects overlaps end-exclusively', () => {
    expect(detectOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 10, endsAt: 20 })).toBe(false);
    expect(detectOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 5, endsAt: 20 })).toBe(true);
  });
});

describe('per-block granularity validation (D-06/D-07/D-07c)', () => {
  it('accepts a block carrying a positive-integer granularity_minutes', () => {
    expect(
      validateWeeklySchedule({ mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] }).ok,
    ).toBe(true);
  });

  it('rejects a block missing granularity_minutes', () => {
    expect(validateWeeklySchedule({ mon: [{ start: '09:00', end: '12:00' }] }).ok).toBe(false);
  });

  it('rejects a granularity_minutes that is not a positive integer', () => {
    for (const bad of [0, -15, 12.5, '15']) {
      expect(
        validateWeeklySchedule({
          mon: [{ start: '09:00', end: '12:00', granularity_minutes: bad as any }],
        }).ok,
        `granularity ${bad}`,
      ).toBe(false);
    }
  });

  it('rejects a block whose length is not a whole multiple of its granularity', () => {
    expect(
      validateWeeklySchedule({ mon: [{ start: '09:00', end: '10:00', granularity_minutes: 45 }] }).ok,
    ).toBe(false);
  });

  it('accepts multiple non-overlapping blocks with different granularities', () => {
    expect(
      validateWeeklySchedule({
        mon: [
          { start: '09:00', end: '12:00', granularity_minutes: 15 },
          { start: '14:00', end: '17:00', granularity_minutes: 45 },
        ],
      }).ok,
    ).toBe(true);
  });
});

describe('computeDailySlots — discrete fixed slots (D-07/D-08/D-09/D-15)', () => {
  const MONDAY = '2026-06-29'; // Monday (UTC)

  it('chops a block into back-to-back fixed slots of its granularity', () => {
    const slots = computeDailySlots({
      date: MONDAY,
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
    });
    expect(slots.length).toBe(12);
    expect(slots[0]).toEqual({ start: '09:00', end: '09:15' });
    expect(slots[slots.length - 1]).toEqual({ start: '11:45', end: '12:00' });
  });

  it('honors per-block granularity within the same day', () => {
    const slots = computeDailySlots({
      date: MONDAY,
      weekly: {
        mon: [
          { start: '09:00', end: '10:00', granularity_minutes: 15 }, // 4 slots
          { start: '14:00', end: '17:00', granularity_minutes: 45 }, // 4 slots
        ],
      },
    });
    expect(slots.length).toBe(8);
    expect(slots.find((s) => s.start === '14:00' && s.end === '14:45')).toBeTruthy();
  });

  it('omits a slot that overlaps a booked interval (end-exclusive)', () => {
    const slots = computeDailySlots({
      date: MONDAY,
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
      booked: [{ start: '10:00', end: '10:15' }],
    });
    expect(slots.length).toBe(11);
    expect(slots.find((s) => s.start === '10:00')).toBeUndefined();
    // end-exclusive: the slots touching the booked boundary survive
    expect(slots.find((s) => s.start === '09:45' && s.end === '10:00')).toBeTruthy();
    expect(slots.find((s) => s.start === '10:15' && s.end === '10:30')).toBeTruthy();
  });

  it('returns no slots when there is no weekly entry for the day (D-09)', () => {
    expect(computeDailySlots({ date: MONDAY, weekly: {} })).toEqual([]);
    expect(
      computeDailySlots({
        date: MONDAY,
        weekly: { tue: [{ start: '09:00', end: '10:00', granularity_minutes: 15 }] },
      }),
    ).toEqual([]);
  });

  it('returns no slots on a full-day unavailable exception (D-08)', () => {
    const slots = computeDailySlots({
      date: MONDAY,
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
      exceptions: [{ is_unavailable: true }],
    });
    expect(slots).toEqual([]);
  });

  it('produces slots from an "available" exception that opens hours outside the weekly pattern (D-07c)', () => {
    const slots = computeDailySlots({
      date: MONDAY, // Monday, but weekly has no mon block
      weekly: {},
      exceptions: [{ is_unavailable: false, start_time: '10:00', end_time: '11:00', granularity_minutes: 15 }],
    });
    expect(slots.length).toBe(4);
    expect(slots[0]).toEqual({ start: '10:00', end: '10:15' });
    expect(slots[3]).toEqual({ start: '10:45', end: '11:00' });
  });

  it('drops slots that fall inside a partial unavailable exception', () => {
    const slots = computeDailySlots({
      date: MONDAY,
      weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
      exceptions: [{ is_unavailable: true, start_time: '10:00', end_time: '10:30' }],
    });
    expect(slots.length).toBe(10);
    expect(slots.find((s) => s.start === '10:00')).toBeUndefined();
    expect(slots.find((s) => s.start === '10:15')).toBeUndefined();
    expect(slots.find((s) => s.start === '09:45')).toBeTruthy();
    expect(slots.find((s) => s.start === '10:30')).toBeTruthy();
  });
});

describe('resolveBooking — effective price + duration (D-12/D-13)', () => {
  it('uses the per-client override price when present', () => {
    const r = resolveBooking({
      serviceDefaultPriceArs: '1000.00',
      clientOverridePriceArs: '750.50',
      slotGranularityMinutes: 15,
    });
    expect(r.effective_price).toBe('750.50');
    expect(r.effective_duration_minutes).toBe(15);
  });

  it('falls back to the service default price when there is no override', () => {
    const r = resolveBooking({
      serviceDefaultPriceArs: '1000.00',
      clientOverridePriceArs: null,
      slotGranularityMinutes: 30,
    });
    expect(r.effective_price).toBe('1000.00');
    expect(r.effective_duration_minutes).toBe(30);
  });

  it('uses the slot granularity as the duration for a normal booking', () => {
    const r = resolveBooking({ serviceDefaultPriceArs: '500.00', slotGranularityMinutes: 45 });
    expect(r.effective_duration_minutes).toBe(45);
  });

  it('lets a staff sobreturno duration win over the slot granularity (D-07b)', () => {
    const r = resolveBooking({
      serviceDefaultPriceArs: '500.00',
      slotGranularityMinutes: 15,
      sobreturnoDurationMinutes: 20,
    });
    expect(r.effective_duration_minutes).toBe(20);
  });
});

describe('evaluateConflicts — structured conflict verdict (D-03/D-04/D-05/D-08)', () => {
  const MONDAY = '2026-06-29';
  // Grid: 12 back-to-back 15-min slots 09:00–12:00.
  const grid = computeDailySlots({
    date: MONDAY,
    weekly: { mon: [{ start: '09:00', end: '12:00', granularity_minutes: 15 }] },
  });
  const pro = (booked: BookedAppointment[] = []) => ({ id: 7, name: 'Dr. Ana', slots: grid, booked });

  it('returns a clean verdict when there are no clashes', () => {
    const v = evaluateConflicts({
      proposed: { start: '11:00', end: '11:15', date: MONDAY },
      callerIsStaff: true,
      professional: pro(),
    });
    expect(v).toEqual({ can_save: true, requires_override: false, can_override: true, conflicts: [] });
  });

  it('flags a scheduled overlap as professional_overlap', () => {
    const v = evaluateConflicts({
      proposed: { start: '10:00', end: '10:15', date: MONDAY },
      callerIsStaff: true,
      professional: pro([{ id: 1, start: '10:00', end: '10:15', state: 'scheduled' }]),
    });
    expect(v.can_save).toBe(false);
    expect(v.requires_override).toBe(true);
    expect(v.conflicts.some((c) => c.type === 'professional_overlap' && c.entity.kind === 'professional')).toBe(true);
  });

  it('flags a requested-state overlap as requested_block (D-08)', () => {
    const v = evaluateConflicts({
      proposed: { start: '10:00', end: '10:15', date: MONDAY },
      callerIsStaff: true,
      professional: pro([{ id: 2, start: '10:00', end: '10:15', state: 'requested' }]),
    });
    expect(v.conflicts.some((c) => c.type === 'requested_block')).toBe(true);
  });

  it('flags a time outside the available grid as professional_availability', () => {
    const v = evaluateConflicts({
      proposed: { start: '13:00', end: '13:15', date: MONDAY },
      callerIsStaff: true,
      professional: pro(),
    });
    expect(v.conflicts.some((c) => c.type === 'professional_availability')).toBe(true);
  });

  it('flags an off-grid (misaligned) time inside working hours as slot_alignment', () => {
    const v = evaluateConflicts({
      proposed: { start: '09:05', end: '09:20', date: MONDAY },
      callerIsStaff: true,
      professional: pro(),
    });
    expect(v.conflicts.some((c) => c.type === 'slot_alignment')).toBe(true);
    expect(v.conflicts.some((c) => c.type === 'professional_availability')).toBe(false);
  });

  it('treats overlap as end-exclusive (touching boundary is not a conflict)', () => {
    const hourGrid = computeDailySlots({
      date: MONDAY,
      weekly: { mon: [{ start: '11:00', end: '12:00', granularity_minutes: 60 }] },
    });
    const v = evaluateConflicts({
      proposed: { start: '11:00', end: '12:00', date: MONDAY },
      callerIsStaff: false,
      professional: { id: 7, name: 'Dr. Ana', slots: hourGrid, booked: [{ id: 9, start: '12:00', end: '13:00', state: 'scheduled' }] },
    });
    expect(v.conflicts).toEqual([]);
    expect(v.can_save).toBe(true);
  });

  it('excludeAppointmentId removes the edited appointment from the clash search (D-04)', () => {
    const v = evaluateConflicts({
      proposed: { start: '10:00', end: '10:15', date: MONDAY },
      callerIsStaff: true,
      excludeAppointmentId: 5,
      professional: pro([{ id: 5, start: '10:00', end: '10:15', state: 'scheduled' }]),
    });
    expect(v.conflicts).toEqual([]);
    expect(v.can_save).toBe(true);
  });

  it('sets can_override from the caller role: false for a Client, true for staff', () => {
    const asClient = evaluateConflicts({
      proposed: { start: '10:00', end: '10:15', date: MONDAY },
      callerIsStaff: false,
      professional: pro([{ id: 1, start: '10:00', end: '10:15', state: 'scheduled' }]),
    });
    expect(asClient.can_override).toBe(false);
    expect(asClient.requires_override).toBe(true);

    const asStaff = evaluateConflicts({
      proposed: { start: '10:00', end: '10:15', date: MONDAY },
      callerIsStaff: true,
      professional: pro([{ id: 1, start: '10:00', end: '10:15', state: 'scheduled' }]),
    });
    expect(asStaff.can_override).toBe(true);
  });

  it('evaluates resource conflicts separately with resource_overlap', () => {
    const v = evaluateConflicts({
      proposed: { start: '10:00', end: '10:15', date: MONDAY },
      callerIsStaff: true,
      professional: pro(),
      resource: { id: 3, name: 'Room A', slots: grid, booked: [{ id: 4, start: '10:00', end: '10:15', state: 'scheduled' }] },
    });
    expect(v.conflicts.some((c) => c.type === 'resource_overlap' && c.entity.kind === 'resource')).toBe(true);
    expect(v.conflicts.some((c) => c.type === 'professional_overlap')).toBe(false);
  });
});
