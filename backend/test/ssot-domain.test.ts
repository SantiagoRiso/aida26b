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
  detectOverlap,
} from '../../shared/src/ssot/domain';
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
    expect(validateWeeklySchedule({ mon: [{ start: '09:00', end: '12:00' }] }).ok).toBe(true);
    expect(validateWeeklySchedule({ funday: [] }).ok).toBe(false);
    expect(validateWeeklySchedule({ mon: [{ start: '9:00', end: '12:00' }] }).ok).toBe(false);
    expect(
      validateWeeklySchedule({
        mon: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }],
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
