import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '../../shared/src/types/roles';
import {
  TERMINAL_STATES,
  TRANSITION_MAP,
  APPOINTMENT_STATE_VALUES,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
  LEDGER_ENTRY_TYPES,
  AUDIT_OUTCOME_VALUES,
  WEEKDAYS,
  schedulerTables,
} from '../../shared/src/ssot/domain';
import { BUSINESS_TZ } from '../src/time';

// Migrations are immutable (forward-only, checksummed), so the SQL side cannot derive from the
// SSOT — these value sets are duplicated by necessity. This guard fails the moment they drift:
// e.g. adding an appointment state or ledger type in the SSOT that the schema's CHECK/trigger
// would reject. Without it, such a change passes code review and fails only at commit time in prod.

const MIGRATIONS = join(__dirname, '..', '..', 'database', 'migrations');
const cutover = readFileSync(join(MIGRATIONS, '20260625_120000_scheduler_schema_cutover.sql'), 'utf8');
const phase4 = readFileSync(join(MIGRATIONS, '20260701_100000_phase4_appointments_ledger_audit.sql'), 'utf8');
const granularityMig = readFileSync(join(MIGRATIONS, '20260701_090000_schedule_exceptions_granularity.sql'), 'utf8');
const blocksServicesMig = readFileSync(join(MIGRATIONS, '20260711_090000_schedule_blocks_services.sql'), 'utf8');

// The quoted values inside the first `IN ( ... )` that `anchor` captures (group 1).
function inList(sql: string, anchor: RegExp): string[] {
  const m = sql.match(anchor);
  if (!m) throw new Error(`pattern not found in migration: ${anchor}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const sorted = (xs: Iterable<string>) => [...xs].sort();

// The integer bound captured by group 1 of a `<column> {>|>=} N` CHECK clause.
function checkBound(sql: string, anchor: RegExp): number {
  const m = sql.match(anchor);
  if (!m) throw new Error(`pattern not found in migration: ${anchor}`);
  return Number(m[1]);
}

const businessesColumns = schedulerTables.businesses.columns;
const professionalServicesColumns = schedulerTables.professional_services.columns;
const scheduleExceptionsColumns = schedulerTables.schedule_exceptions.columns;

describe('SSOT ↔ immutable-migration drift guards', () => {
  it('user roles match the auth.users role CHECK', () => {
    expect(sorted(inList(cutover, /CHECK \(role IN \(([^)]+)\)\)/))).toEqual(sorted(ROLES));
  });

  it('appointment states match the appointments state CHECK', () => {
    expect(sorted(inList(cutover, /CHECK \(state IN \(([^)]+)\)\)/))).toEqual(sorted(APPOINTMENT_STATE_VALUES));
  });

  it('terminal states match the transition trigger', () => {
    expect(sorted(inList(phase4, /OLD\.state IN \(([^)]+)\)/))).toEqual(sorted(TERMINAL_STATES));
  });

  it('transition edges match the transition trigger', () => {
    expect(sorted(inList(phase4, /OLD\.state = 'requested' AND NEW\.state IN \(([^)]+)\)/)))
      .toEqual(sorted(TRANSITION_MAP.requested));
    expect(sorted(inList(phase4, /OLD\.state = 'scheduled' AND NEW\.state IN \(([^)]+)\)/)))
      .toEqual(sorted(TRANSITION_MAP.scheduled));
  });

  it('ledger entry types match the effective (phase4) entry_type CHECK', () => {
    // The original cutover CHECK had 3 types; phase4 supersedes it with 4 — assert against phase4.
    expect(sorted(inList(phase4, /entry_type IN \(([^)]+)\)/)))
      .toEqual(sorted(LEDGER_ENTRY_TYPES.map((t) => t.value)));
  });

  it('default cancellation cutoff matches the businesses column default', () => {
    const m = phase4.match(/cancellation_cutoff_hours\s+INTEGER\s+NOT NULL\s+DEFAULT\s+(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(DEFAULT_CANCELLATION_CUTOFF_HOURS);
  });

  it('audit outcomes match the audit_events outcome CHECK', () => {
    expect(sorted(inList(cutover, /CHECK \(outcome IN \(([^)]+)\)\)/))).toEqual(sorted(AUDIT_OUTCOME_VALUES));
  });

  it('weekdays match the schedule_blocks weekday CHECK', () => {
    expect(sorted(inList(blocksServicesMig, /CHECK \(weekday IN \(([^)]+)\)\)/))).toEqual(sorted(WEEKDAYS));
  });

  it('granularity_minutes positivity CHECK matches the schedule_exceptions column validator', () => {
    // The CHECK requires `> 0`; the SSOT validator expresses the same floor as `minValue: 1`.
    const bound = checkBound(granularityMig, /granularity_minutes IS NOT NULL AND granularity_minutes > (\d+)/);
    expect(bound + 1).toBe(scheduleExceptionsColumns.granularity_minutes.validator.minValue);
  });

  it('booking-window CHECKs match the businesses and professional_services column validators', () => {
    const businessesBlock = blocksServicesMig.match(/ALTER TABLE businesses[\s\S]*?;/)![0];
    const proServicesBlock = blocksServicesMig.match(/ALTER TABLE professional_services[\s\S]*?;/)![0];

    const businessesMin = checkBound(businessesBlock, /min_booking_days >= (\d+)/);
    const businessesMax = checkBound(businessesBlock, /max_booking_days >= (\d+)/);
    const proServicesMin = checkBound(proServicesBlock, /min_booking_days >= (\d+)/);
    const proServicesMax = checkBound(proServicesBlock, /max_booking_days >= (\d+)/);

    expect(businessesMin).toBe(businessesColumns.min_booking_days.validator.minValue);
    expect(businessesMax).toBe(businessesColumns.max_booking_days.validator.minValue);
    expect(proServicesMin).toBe(professionalServicesColumns.min_booking_days.validator.minValue);
    expect(proServicesMax).toBe(professionalServicesColumns.max_booking_days.validator.minValue);
  });

  it('businesses.timezone default matches BUSINESS_TZ', () => {
    const m = cutover.match(/timezone\s+TEXT\s+NOT NULL\s+DEFAULT\s+'([^']+)'/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(BUSINESS_TZ);
  });

  it('users_directory view carries every users/clients/professionals descriptor column', () => {
    // Generic reads for the three people entities are `SELECT *` against auth.users_directory,
    // whose column list is hand-maintained across migrations — a descriptor column the view
    // forgot silently vanishes from every read. The effective view is the LAST declaration in
    // filename (= application) order, since CREATE OR REPLACE fully re-declares it.
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+auth\.users_directory\s+AS\s+SELECT\s+([\s\S]*?)\s+FROM\s/gi;
    let selectList: string | null = null;
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      for (const m of sql.matchAll(viewRe)) selectList = m[1];
    }
    expect(selectList).not.toBeNull();

    // Column exposed on the wire: the alias when present, else the (unqualified) column name.
    const viewColumns = new Set(
      selectList!
        .split(',')
        .map((entry) => entry.trim().split(/\s+AS\s+|\s+/i).pop()!.replace(/^.*\./, '').toLowerCase()),
    );

    const descriptorColumns = new Set([
      ...Object.keys(schedulerTables.users.columns),
      ...Object.keys(schedulerTables.clients.columns),
      ...Object.keys(schedulerTables.professionals.columns),
    ]);

    const missing = [...descriptorColumns].filter((c) => !viewColumns.has(c));
    expect(missing).toEqual([]);
  });

  it('businesses.currency_code default/CHECK match the column validator pattern', () => {
    const m = cutover.match(
      /currency_code\s+CHAR\(3\)\s+NOT NULL\s+DEFAULT\s+'([^']+)'\s+CHECK \(currency_code = '([^']+)'\)/,
    );
    expect(m).not.toBeNull();
    const [, defaultValue, checkValue] = m!;
    const pattern = businessesColumns.currency_code.validator.pattern;
    const patternMatch = pattern.match(/^\^([^$]+)\$$/);
    expect(patternMatch).not.toBeNull();
    const expectedCurrency = patternMatch![1];
    expect(defaultValue).toBe(expectedCurrency);
    expect(checkValue).toBe(expectedCurrency);
  });
});
