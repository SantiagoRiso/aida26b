import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '../../shared/src/types/roles';
import {
  TERMINAL_STATES,
  TRANSITION_MAP,
  APPOINTMENT_STATE_VALUES,
  DEFAULT_CANCELLATION_CUTOFF_HOURS,
  LEDGER_ENTRY_TYPES,
} from '../../shared/src/ssot/domain';

// Migrations are immutable (forward-only, checksummed), so the SQL side cannot derive from the
// SSOT — these value sets are duplicated by necessity. This guard fails the moment they drift:
// e.g. adding an appointment state or ledger type in the SSOT that the schema's CHECK/trigger
// would reject. Without it, such a change passes code review and fails only at commit time in prod.

const MIGRATIONS = join(__dirname, '..', '..', 'database', 'migrations');
const cutover = readFileSync(join(MIGRATIONS, '20260625_120000_scheduler_schema_cutover.sql'), 'utf8');
const phase4 = readFileSync(join(MIGRATIONS, '20260701_100000_phase4_appointments_ledger_audit.sql'), 'utf8');

// The quoted values inside the first `IN ( ... )` that `anchor` captures (group 1).
function inList(sql: string, anchor: RegExp): string[] {
  const m = sql.match(anchor);
  if (!m) throw new Error(`pattern not found in migration: ${anchor}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const sorted = (xs: Iterable<string>) => [...xs].sort();

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
});
