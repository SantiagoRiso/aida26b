import { describe, it, expect } from 'vitest';
import { structure } from '../../shared/src/ssot/structure';
import { validateFullObject, validateFieldIssue } from '../../shared/src/validation/validate';
import {
  getSchedulable,
  isBusinessScoped,
  isProtected,
  getCrudPolicy,
  getSoftDeletePolicy,
  isOwnerScheduledTable,
  getProfessionalScheduleOwnerFk,
  getResourceScheduleOwnerFk,
  ownerHasResourceColumn,
  isInternalColumn,
  getPkFields,
} from '../../shared/src/utils/utils';
import {
  computeServiceSlots,
  resolveBooking,
  evaluateConflicts,
  detectOverlap,
  TERMINAL_STATES,
  TRANSITION_MAP,
  assertValidTransition,
  canMarkNoShow,
  canCompleteAppointment,
  LEDGER_ENTRY_TYPES,
  BUSINESS_TZ,
  ARGENTINA_OFFSET_MS,
  businessDate,
  parseRecurrenceRule,
  validateRecurrenceRuleIssues,
} from '../../shared/src/ssot/domain';
import type { BookedAppointment, LedgerEntryType, RecurrenceRuleFields } from '../../shared/src/ssot/domain';
import type {
  TableStructure,
  SchedulableCapability,
  ColumnDef,
  ColumnValue,
  LocalizedText,
} from '../../shared/src/types/types';
import type { TableKey } from '../../shared/src/ssot/derived';

// eslint-disable-next-line no-restricted-syntax -- type-guard boundary: narrows an unvalidated SSOT field value before asserting its shape
function isLocalized(text: unknown): text is LocalizedText {
  if (!text || typeof text !== 'object') return false;
  const candidate = text as LocalizedText;
  return typeof candidate.es === 'string' && typeof candidate.en === 'string';
}

const tableKeys = Object.keys(structure.tables);

describe('SSOT metadata contract', () => {
  it('accepts rich scheduler metadata: crud policy, soft-delete, status, schedulable capability', () => {
    const schedulable: SchedulableCapability = {
      calendarLabel: { es: 'Profesional', en: 'Professional' },
      identityField: 'id',
      displayField: 'display_name',
      ownerForeignKey: 'professional_id',
      availability: { weeklySource: 'schedule_blocks', exceptionSource: 'schedule_exceptions' },
      conflict: { overridable: true },
      rules: { availability: 'computeServiceSlots', conflict: 'detectOverlap' },
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
    'professional_services',
    'schedule_blocks',
    'schedule_block_services',
    'schedule_exceptions',
    'appointments',
    'appointment_series',
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

  // The guard splits owner kinds by whether the schedulable's rows are role-discriminated users.
  // These names must keep matching the migration's column names (drift guard).
  it('kind-split owner FK accessors classify professionals as user-owned, resources as not', () => {
    expect(getProfessionalScheduleOwnerFk()).toBe('professional_user_id');
    expect(getResourceScheduleOwnerFk()).toBe('resource_id');
  });

  it('ownerHasResourceColumn: dual-owner schedule tables carry the resource FK, professional-only tables do not', () => {
    expect(ownerHasResourceColumn('schedule_blocks')).toBe(true);
    expect(ownerHasResourceColumn('schedule_exceptions')).toBe(true);
    expect(ownerHasResourceColumn('professional_services')).toBe(false);
  });
});

describe('ordinary vs protected CRUD boundaries', () => {
  const ordinary: TableKey[] = [
    'clients',
    'professionals',
    'resources',
    'services',
    'client_professional_services',
    'schedule_blocks',
    'schedule_block_services',
    'schedule_exceptions',
  ];
  const protectedTables: TableKey[] = [
    'businesses',
    'sessions',
    'appointments',
    'ledger_entries',
    'audit_events',
    'calendar_grants',
  ];

  it('ordinary configuration entities are generic-CRUD eligible and not protected', () => {
    for (const t of ordinary) {
      expect(isProtected(t), `${t} protected`).toBe(false);
      expect(getCrudPolicy(t), `${t} crud`).toBeTruthy();
    }
  });

  it('workflow/identity entities are protected and not generic-CRUD eligible', () => {
    for (const t of protectedTables) {
      expect(isProtected(t), `${t} protected`).toBe(true);
      expect(getCrudPolicy(t), `${t} crud`).toBeUndefined();
    }
  });

  // users carves out a narrow read-only exception: the admin Usuarios screen lists accounts
  // through generic GET, but every write stays unreachable — same as the other protected tables.
  it('users stays protected but declares a read-only, Admin-only crud exception', () => {
    expect(isProtected('users')).toBe(true);
    const policy = getCrudPolicy('users');
    expect(policy?.read).toBe(true);
    expect(policy?.create).toBe(false);
    expect(policy?.update).toBe(false);
    expect(policy?.delete).toBe(false);
  });

  it('withholds generic delete where the schema grants no DELETE', () => {
    expect(getCrudPolicy('client_professional_services')?.delete).toBe(false);
    expect(getCrudPolicy('schedule_exceptions')?.delete).toBe(true);
    expect(getCrudPolicy('schedule_blocks')?.delete).toBe(true);
    expect(getCrudPolicy('schedule_block_services')?.delete).toBe(true);
  });

  // The service catalog is admin-owned config: receptionists consume services through the
  // booking form, they do not curate the catalog. Read stays open to every booking role.
  it('services catalog is admin-only for mutations', () => {
    const rr = structure.tables.services.roleRequired!;
    expect(rr.create).toEqual(['Admin']);
    expect(rr.update).toEqual(['Admin']);
    expect(rr.delete).toEqual(['Admin']);
    expect(rr.read).toContain('Receptionist');
    expect(rr.read).toContain('Professional');
    expect(rr.read).toContain('Client');
  });
});

describe('soft-delete and status metadata', () => {
  it('marks the referenced core records as soft-deletable', () => {
    for (const t of ['clients', 'professionals', 'resources', 'services', 'users'] as TableKey[]) {
      expect(getSoftDeletePolicy(t)?.deletedAtColumn, t).toBe('deleted_at');
    }
  });

  it('does not soft-delete records that have no deleted_at column', () => {
    for (const t of ['client_professional_services', 'schedule_blocks', 'schedule_block_services', 'schedule_exceptions'] as TableKey[]) {
      expect(getSoftDeletePolicy(t), t).toBeUndefined();
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

  it('carries nullable, server-derived series_id and occurrence_date columns', () => {
    expect(cols.series_id).toBeTruthy();
    expect(cols.series_id.validator?.nullable).toBe(true);
    expect(cols.series_id.editable).toBe(false);
    expect(cols.series_id.foreignKey?.table).toBe('appointment_series');
    expect(cols.occurrence_date).toBeTruthy();
    expect(cols.occurrence_date.validator?.nullable).toBe(true);
    expect(cols.occurrence_date.editable).toBe(false);
  });
});

describe('appointment_series shape (protected, bespoke authz)', () => {
  const table = structure.tables.appointment_series as TableStructure;
  const cols = table.columns as Record<string, ColumnDef>;

  it('is protected with no crud/roleRequired/ownership/grantScope metadata', () => {
    expect(table.protected).toBe(true);
    expect(table.crud).toBeUndefined();
    expect(table.roleRequired).toBeUndefined();
    expect(table.ownership).toBeUndefined();
    expect(table.grantScope).toBeUndefined();
  });

  it('derives business via professional_user_id -> auth.users', () => {
    expect(table.businessJoin?.paths).toEqual([
      { parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' },
    ]);
  });

  it('declares a status discriminator over the status column', () => {
    expect(table.status?.column).toBe('status');
    const values = table.status?.values.map((v) => v.value) ?? [];
    expect(values).toEqual(['active', 'ended']);
  });

  it('declares every column from the design spec', () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        'id',
        'client_user_id',
        'professional_user_id',
        'service_id',
        'resource_id',
        'frequency',
        'interval',
        'weekday',
        'week_of_month',
        'day_of_month',
        'start_time',
        'duration_minutes',
        'price_ars',
        'start_date',
        'end_kind',
        'end_count',
        'end_date',
        'created_by_user_id',
        'status',
      ]),
    );
  });

  it('marks server-derived FK columns editable: false', () => {
    for (const key of ['client_user_id', 'professional_user_id', 'service_id', 'resource_id', 'created_by_user_id']) {
      expect(cols[key].editable, key).toBe(false);
      expect(cols[key].foreignKey, key).toBeTruthy();
    }
  });

  it('keeps resource_id/weekday/week_of_month/day_of_month/end_count/end_date nullable', () => {
    for (const key of ['resource_id', 'weekday', 'week_of_month', 'day_of_month', 'end_count', 'end_date']) {
      expect(cols[key].validator?.nullable, key).toBe(true);
    }
  });
});

describe('business scoping: only direct owners carry business_id', () => {
  it('direct owners are business-scoped (resources/services/audit_events carry business_id directly)', () => {
    for (const t of ['resources', 'services', 'audit_events'] as TableKey[]) {
      expect(isBusinessScoped(t), t).toBe(true);
    }
    expect(isBusinessScoped('users')).toBe(true);
  });

  it('clients and professionals are businessScoped (backed by auth.users which carries business_id)', () => {
    expect(isBusinessScoped('clients')).toBe(true);
    expect(isBusinessScoped('professionals')).toBe(true);
  });

  it('derived-scope entities are not business-scoped', () => {
    for (const t of [
      'client_professional_services',
      'schedule_blocks',
      'schedule_block_services',
      'schedule_exceptions',
      'appointments',
      'ledger_entries',
      'calendar_grants',
    ] as TableKey[]) {
      expect(isBusinessScoped(t), t).toBe(false);
    }
  });
});

describe('field-level validation', () => {
  it('returns a per-field error map keyed by field name', () => {
    const result = validateFullObject('clients', {});
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

describe('validation issues name the rule that failed', () => {
  const issuesFor = (table: TableKey, body: Record<string, ColumnValue>) => {
    const result = validateFullObject(table, body);
    if (!('fields' in result)) throw new Error('expected a validation failure');
    return result;
  };

  it('names the rule and keeps the English prose for the same failure', () => {
    const result = issuesFor('clients', {});
    expect(result.fieldDetails.display_name).toEqual({ key: 'required' });
    expect(result.fields.display_name).toBe('display_name is required');
  });

  it('names the constraint a pattern expresses rather than "invalid format"', () => {
    expect(validateFieldIssue('clients', 'email', 'not-an-email')).toEqual({ key: 'emailFormat' });
    expect(validateFieldIssue('services', 'default_price_ars', '12.345')).toEqual({ key: 'amountFormat' });
    expect(validateFieldIssue('schedule_blocks', 'start_time', '9am')).toEqual({ key: 'timeOfDayFormat' });
  });

  it('carries the bound as a parameter so the limit survives translation', () => {
    expect(validateFieldIssue('users', 'username', 'x'.repeat(81)))
      .toEqual({ key: 'maxLength', params: { max: 80 } });
    expect(validateFieldIssue('services', 'default_duration_minutes', 0))
      .toEqual({ key: 'minValue', params: { min: 1 } });
  });

  it('flags a field the table does not accept', () => {
    const result = issuesFor('clients', { display_name: 'Ana', nope: 'x' } as Record<string, ColumnValue>);
    expect(result.fieldDetails.nope).toEqual({ key: 'unknownField' });
  });

  it('reports a valid value as no issue at all', () => {
    expect(validateFieldIssue('clients', 'email', 'ana@example.com')).toBeUndefined();
  });
});

describe('pure scheduling rules (availability is computed, not stored)', () => {
  it('detects overlaps end-exclusively', () => {
    expect(detectOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 10, endsAt: 20 })).toBe(false);
    expect(detectOverlap({ startsAt: 0, endsAt: 10 }, { startsAt: 5, endsAt: 20 })).toBe(true);
  });
});

describe('resolveBooking — effective price + duration', () => {
  it('uses the per-client override price when present', () => {
    const r = resolveBooking({
      serviceDefaultPriceArs: '1000.00',
      clientOverridePriceArs: '750.50',
      serviceDefaultDurationMinutes: 15,
    });
    expect(r.effective_price).toBe('750.50');
    expect(r.effective_duration_minutes).toBe(15);
  });

  it('falls back to the service default price when there is no override', () => {
    const r = resolveBooking({
      serviceDefaultPriceArs: '1000.00',
      clientOverridePriceArs: null,
      serviceDefaultDurationMinutes: 30,
    });
    expect(r.effective_price).toBe('1000.00');
    expect(r.effective_duration_minutes).toBe(30);
  });

  it('uses the service default duration for a normal booking', () => {
    const r = resolveBooking({ serviceDefaultPriceArs: '500.00', serviceDefaultDurationMinutes: 45 });
    expect(r.effective_duration_minutes).toBe(45);
  });

  it('lets a staff sobreturno duration win over the service default', () => {
    const r = resolveBooking({
      serviceDefaultPriceArs: '500.00',
      serviceDefaultDurationMinutes: 15,
      sobreturnoDurationMinutes: 20,
    });
    expect(r.effective_duration_minutes).toBe(20);
  });
});

describe('evaluateConflicts — structured conflict verdict', () => {
  const MONDAY = '2026-06-29';
  const grid = computeServiceSlots({
    blocks: [{ start: '09:00', end: '12:00', slot_minutes: 15 }],
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

  it('flags a requested-state overlap as requested_block', () => {
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
    const hourGrid = computeServiceSlots({
      blocks: [{ start: '11:00', end: '12:00', slot_minutes: 60 }],
    });
    const v = evaluateConflicts({
      proposed: { start: '11:00', end: '12:00', date: MONDAY },
      callerIsStaff: false,
      professional: { id: 7, name: 'Dr. Ana', slots: hourGrid, booked: [{ id: 9, start: '12:00', end: '13:00', state: 'scheduled' }] },
    });
    expect(v.conflicts).toEqual([]);
    expect(v.can_save).toBe(true);
  });

  it('excludeAppointmentId removes the edited appointment from the clash search', () => {
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

describe('appointment state transition map (Phase 4)', () => {
  it('allows no-show only once a scheduled appointment enters the cancellation window', () => {
    const now = Date.parse('2026-07-16T12:00:00Z');
    expect(canMarkNoShow('scheduled', '2026-07-17T13:00:00Z', 24, now)).toBe(false);
    expect(canMarkNoShow('scheduled', '2026-07-17T12:00:00Z', 24, now)).toBe(true);
    expect(canMarkNoShow('scheduled', '2026-07-16T11:00:00Z', 24, now)).toBe(true);
    expect(canMarkNoShow('requested', '2026-07-16T11:00:00Z', 24, now)).toBe(false);
  });

  it('allows completion only after a scheduled appointment starts', () => {
    const now = Date.parse('2026-07-16T12:00:00Z');
    expect(canCompleteAppointment('scheduled', '2026-07-16T12:01:00Z', now)).toBe(false);
    expect(canCompleteAppointment('scheduled', '2026-07-16T12:00:00Z', now)).toBe(true);
    expect(canCompleteAppointment('requested', '2026-07-16T11:00:00Z', now)).toBe(false);
  });

  it('assertValidTransition allows requested → scheduled', () => {
    expect(assertValidTransition('requested', 'scheduled')).toEqual({ ok: true });
  });

  it('assertValidTransition allows requested → rejected', () => {
    expect(assertValidTransition('requested', 'rejected')).toEqual({ ok: true });
  });

  it('assertValidTransition allows requested → canceled', () => {
    expect(assertValidTransition('requested', 'canceled')).toEqual({ ok: true });
  });

  it('assertValidTransition allows scheduled → completed', () => {
    expect(assertValidTransition('scheduled', 'completed')).toEqual({ ok: true });
  });

  it('assertValidTransition allows scheduled → canceled', () => {
    expect(assertValidTransition('scheduled', 'canceled')).toEqual({ ok: true });
  });

  it('assertValidTransition allows scheduled → no_show', () => {
    expect(assertValidTransition('scheduled', 'no_show')).toEqual({ ok: true });
  });

  it('assertValidTransition rejects requested → completed (illegal edge)', () => {
    const r = assertValidTransition('requested', 'completed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBeTruthy();
  });

  it('assertValidTransition rejects completed → scheduled (terminal source)', () => {
    const r = assertValidTransition('completed', 'scheduled');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/terminal/i);
  });

  it('assertValidTransition rejects canceled → requested (terminal source)', () => {
    const r = assertValidTransition('canceled', 'requested');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/terminal/i);
  });

  it('assertValidTransition rejects no_show → scheduled (terminal source)', () => {
    const r = assertValidTransition('no_show', 'scheduled');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/terminal/i);
  });

  it('assertValidTransition rejects rejected → scheduled (terminal source)', () => {
    const r = assertValidTransition('rejected', 'scheduled');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/terminal/i);
  });

  it('TERMINAL_STATES contains completed, canceled, no_show, rejected', () => {
    expect(TERMINAL_STATES.has('completed')).toBe(true);
    expect(TERMINAL_STATES.has('canceled')).toBe(true);
    expect(TERMINAL_STATES.has('no_show')).toBe(true);
    expect(TERMINAL_STATES.has('rejected')).toBe(true);
  });

  it('TERMINAL_STATES does not contain requested or scheduled', () => {
    expect(TERMINAL_STATES.has('requested')).toBe(false);
    expect(TERMINAL_STATES.has('scheduled')).toBe(false);
  });

  it('TRANSITION_MAP has entries only for requested and scheduled', () => {
    expect(Object.keys(TRANSITION_MAP)).toEqual(expect.arrayContaining(['requested', 'scheduled']));
    expect(Object.keys(TRANSITION_MAP)).not.toContain('completed');
    expect(Object.keys(TRANSITION_MAP)).not.toContain('canceled');
  });
});

describe('ledger entry types (Phase 4 — four values)', () => {
  it('LEDGER_ENTRY_TYPES contains exactly four entries', () => {
    expect(LEDGER_ENTRY_TYPES).toHaveLength(4);
  });

  it('LEDGER_ENTRY_TYPES value set equals {charge, payment, adjustment_debit, adjustment_credit}', () => {
    const values = LEDGER_ENTRY_TYPES.map((t) => t.value);
    expect(values).toContain('charge');
    expect(values).toContain('payment');
    expect(values).toContain('adjustment_debit');
    expect(values).toContain('adjustment_credit');
  });

  it('LEDGER_ENTRY_TYPES does not contain the old adjustment type', () => {
    const values = LEDGER_ENTRY_TYPES.map((t) => t.value);
    expect(values).not.toContain('adjustment');
  });

  it('all LEDGER_ENTRY_TYPES entries have {es, en} labels', () => {
    for (const t of LEDGER_ENTRY_TYPES) {
      expect(typeof t.label.es).toBe('string');
      expect(typeof t.label.en).toBe('string');
      expect(t.label.es.length).toBeGreaterThan(0);
      expect(t.label.en.length).toBeGreaterThan(0);
    }
  });

  it('LedgerEntryType type-checks against the four values', () => {
    // Compile-time check: confirm the type accepts the four values.
    const types: LedgerEntryType[] = ['charge', 'payment', 'adjustment_debit', 'adjustment_credit'];
    expect(types).toHaveLength(4);
  });
});

describe('appointments SSOT: staff_note column metadata (Phase 4)', () => {
  it('appointments table has a staff_note column in the SSOT', () => {
    const cols = structure.tables.appointments.columns as Record<string, ColumnDef>;
    expect(cols.staff_note).toBeDefined();
  });

  it('staff_note is nullable', () => {
    const cols = structure.tables.appointments.columns as Record<string, ColumnDef>;
    expect(cols.staff_note.validator?.nullable).toBe(true);
  });

  it('staff_note has {es, en} labels', () => {
    const cols = structure.tables.appointments.columns as Record<string, ColumnDef>;
    expect(typeof cols.staff_note.label?.es).toBe('string');
    expect(typeof cols.staff_note.label?.en).toBe('string');
  });
});

describe('clients SSOT: DNI column and secret-free read source', () => {
  it('clients declares a nullable, filterable, sortable dni column with {es,en} labels', () => {
    const cols = structure.tables.clients.columns as Record<string, ColumnDef>;
    expect(cols.dni).toBeDefined();
    expect(cols.dni.type).toBe('string');
    expect(cols.dni.validator?.nullable).toBe(true);
    expect(cols.dni.filterable).toBe(true);
    expect(cols.dni.sortable).toBe(true);
    expect(typeof cols.dni.label?.es).toBe('string');
    expect(typeof cols.dni.label?.en).toBe('string');
  });

  it('clients and professionals read through the secret-free directory view', () => {
    // Writes stay on auth.users; reads must project the view so password columns never leak.
    expect((structure.tables.clients as TableStructure).sqlReadTable).toBe('auth.users_directory');
    expect((structure.tables.professionals as TableStructure).sqlReadTable).toBe('auth.users_directory');
    expect((structure.tables.clients as TableStructure).sqlTable).toBe('auth.users');
  });
});

describe('owner-scheduled tables are derived from schedulable capabilities', () => {
  // The generic write path fires the own/admin/grant schedule guard for these tables. The set
  // must come from the descriptors (every schedulable capability's availability sources), not
  // from names hardcoded in the engine — else a rename silently drops the guard.
  it('matches exactly the availability sources declared by schedulable capabilities', () => {
    const expected = new Set<string>();
    for (const key of Object.keys(structure.tables) as Array<keyof typeof structure.tables>) {
      const schedulable = getSchedulable(key);
      if (!schedulable) continue;
      expected.add(schedulable.availability.weeklySource);
      expected.add(schedulable.availability.exceptionSource);
    }
    expect(expected.size).toBeGreaterThan(0);
    for (const key of Object.keys(structure.tables) as TableKey[]) {
      expect(isOwnerScheduledTable(key)).toBe(expected.has(key));
    }
  });

  it('guards schedule_blocks and schedule_exceptions but not appointments or services', () => {
    expect(isOwnerScheduledTable('schedule_blocks')).toBe(true);
    expect(isOwnerScheduledTable('schedule_exceptions')).toBe(true);
    expect(isOwnerScheduledTable('appointments')).toBe(false);
    expect(isOwnerScheduledTable('services')).toBe(false);
  });
});

describe('isInternalColumn: the single predicate both generic renderers hide columns by', () => {
  it('flags the pk and business_id, and only those, on a table that carries both', () => {
    for (const key of Object.keys(structure.tables.services.columns)) {
      expect(isInternalColumn('services', key), key).toBe(key === 'id' || key === 'business_id');
    }
  });

  it('flags only the pk on a table with no business_id column', () => {
    for (const key of Object.keys(structure.tables.professionals.columns)) {
      expect(isInternalColumn('professionals', key), key).toBe(key === 'id');
    }
    // The genuinely useful editable:false fields on clients (email, username) are not internal.
    expect(isInternalColumn('clients', 'email')).toBe(false);
    expect(isInternalColumn('clients', 'username')).toBe(false);
    expect(isInternalColumn('clients', 'id')).toBe(true);
  });

  // No table in the live SSOT currently declares a composite pk, but the predicate is written
  // against getPkFields (which returns every part of an array pk), not a single `pk` string
  // comparison, so a future composite-pk table is covered without touching either renderer.
  it('derives from every part of a composite pk via getPkFields, not a single `pk` string', () => {
    for (const key of Object.keys(structure.tables) as TableKey[]) {
      const pkFields = getPkFields(key);
      for (const field of pkFields) {
        expect(isInternalColumn(key, field), `${key}.${field}`).toBe(true);
      }
    }
  });
});

describe('BUSINESS_TZ ↔ ARGENTINA_OFFSET_MS drift guard', () => {
  function ianaOffsetMs(at: Date): number {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')!.value;
    if (name === 'GMT') return 0;
    const m = name.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) throw new Error(`unparseable offset for ${BUSINESS_TZ}: ${name}`);
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60 * 1000;
  }

  it('the fixed offset matches the IANA zone in both halves of the current year (no DST)', () => {
    // Argentina abolished DST in 2009; time.ts's businessDateTimeToISO relies on the offset
    // being constant. Probing summer and winter of the running year catches a tzdata change in CI.
    const year = new Date().getUTCFullYear();
    expect(ianaOffsetMs(new Date(Date.UTC(year, 0, 15)))).toBe(ARGENTINA_OFFSET_MS);
    expect(ianaOffsetMs(new Date(Date.UTC(year, 6, 15)))).toBe(ARGENTINA_OFFSET_MS);
  });
});

describe('businessDate', () => {
  it('names the Argentine calendar day, not the UTC one', () => {
    // 02:30 UTC is still the previous evening in Buenos Aires.
    expect(businessDate(new Date('2026-07-21T02:30:00.000Z'))).toBe('2026-07-20');
    expect(businessDate(new Date('2026-07-21T12:00:00.000Z'))).toBe('2026-07-21');
  });
});

describe('booking-window columns', () => {
  it('businesses and professional_services carry min/max_booking_days', () => {
    expect(Object.keys((structure.tables.businesses as TableStructure).columns)).toEqual(
      expect.arrayContaining(['min_booking_days', 'max_booking_days']),
    );
    expect(Object.keys((structure.tables.professional_services as TableStructure).columns)).toEqual(
      expect.arrayContaining(['min_booking_days', 'max_booking_days']),
    );
  });
});

describe('recurrence rule validator: keys + params, not just English prose', () => {
  const validRule: RecurrenceRuleFields = {
    frequency: 'weekly',
    interval: 1,
    weekday: 'mon',
    week_of_month: null,
    day_of_month: null,
    start_time: '10:00',
    start_date: '2026-07-20',
    end_kind: 'count',
    end_count: 4,
    end_date: null,
  };

  it('a fully valid rule parses to data with no failures', () => {
    const result = parseRecurrenceRule(validRule);
    expect('data' in result).toBe(true);
  });

  it('names an invalid frequency distinctly from the generic notInOptions shape', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, frequency: 'daily' }).frequency)
      .toEqual({ key: 'recurrenceFrequencyInvalid' });
  });

  it('carries the interval floor as a param', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, interval: 0 }).interval)
      .toEqual({ key: 'recurrenceIntervalInvalid', params: { min: 1 } });
  });

  it('requires weekday for weekly and monthly_dow, by the same key', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, weekday: null }).weekday)
      .toEqual({ key: 'recurrenceWeekdayRequired' });
    expect(validateRecurrenceRuleIssues({ ...validRule, frequency: 'monthly_dow', weekday: null, week_of_month: 2 }).weekday)
      .toEqual({ key: 'recurrenceWeekdayRequired' });
  });

  it('flags a field that does not apply to the chosen frequency', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, week_of_month: 2 }).week_of_month)
      .toEqual({ key: 'recurrenceFieldNotApplicable' });
    expect(validateRecurrenceRuleIssues({ ...validRule, frequency: 'monthly_dom', day_of_month: 15, weekday: 'mon' }).weekday)
      .toEqual({ key: 'recurrenceFieldNotApplicable' });
  });

  it('carries the 1..5 bound as params for an out-of-range week_of_month', () => {
    expect(
      validateRecurrenceRuleIssues({ ...validRule, frequency: 'monthly_dow', week_of_month: 9 }).week_of_month,
    ).toEqual({ key: 'recurrenceWeekOfMonthRange', params: { min: 1, max: 5 } });
  });

  it('carries the 1..31 bound as params for an out-of-range day_of_month', () => {
    expect(
      validateRecurrenceRuleIssues({
        ...validRule,
        frequency: 'monthly_dom',
        weekday: null,
        day_of_month: 45,
      }).day_of_month,
    ).toEqual({ key: 'recurrenceDayOfMonthRange', params: { min: 1, max: 31 } });
  });

  it('names an invalid end_kind distinctly', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, end_kind: 'forever' }).end_kind)
      .toEqual({ key: 'recurrenceEndKindInvalid' });
  });

  it('requires end_count for end_kind=count', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, end_count: null }).end_count)
      .toEqual({ key: 'recurrenceEndCountRequired' });
  });

  it('flags an end_date sent alongside end_kind=count as not applicable', () => {
    expect(validateRecurrenceRuleIssues({ ...validRule, end_date: '2026-08-01' }).end_date)
      .toEqual({ key: 'recurrenceEndFieldNotApplicable' });
  });

  it('distinguishes a missing end_date (required) from a malformed one (dateFormat) for end_kind=until', () => {
    const untilRule: RecurrenceRuleFields = { ...validRule, end_kind: 'until', end_count: null, end_date: '2026-08-01' };
    expect(validateRecurrenceRuleIssues({ ...untilRule, end_date: null }).end_date).toEqual({ key: 'required' });
    expect(validateRecurrenceRuleIssues({ ...untilRule, end_date: '08/01/2026' }).end_date).toEqual({ key: 'dateFormat' });
  });

  it('flags an end_date before start_date once the format is otherwise valid', () => {
    const untilRule: RecurrenceRuleFields = { ...validRule, end_kind: 'until', end_count: null, end_date: '2026-01-01' };
    expect(validateRecurrenceRuleIssues(untilRule).end_date).toEqual({ key: 'recurrenceEndDateBeforeStart' });
  });

  it('flags end_count sent alongside end_kind=open/until as not applicable', () => {
    expect(
      validateRecurrenceRuleIssues({ ...validRule, end_kind: 'open', end_count: null, end_date: null }).end_count,
    ).toBeUndefined();
    expect(
      validateRecurrenceRuleIssues({ ...validRule, end_kind: 'open', end_count: 3 }).end_count,
    ).toEqual({ key: 'recurrenceEndFieldNotApplicable' });
  });

  it('parseRecurrenceRule threads fieldDetails alongside fields on failure', () => {
    const result = parseRecurrenceRule({ ...validRule, frequency: 'daily' });
    if (!('fields' in result)) throw new Error('expected a validation failure');
    expect(result.fields.frequency).toContain('must be one of');
    expect(result.fieldDetails.frequency).toEqual({ key: 'recurrenceFrequencyInvalid' });
  });
});
