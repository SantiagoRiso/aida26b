import { describe, it, expect } from 'vitest';
import { auditEventLabel } from '../../shared/src/ssot/domain/audit-events';
import { tableOf } from '../../shared/src/utils/utils';
import { APPOINTMENT_STATES, LEDGER_ENTRY_TYPES } from '../../shared/src/ssot/domain';

// auditEventLabel is the presentation layer for backend/src/audit.ts's event vocabulary: every
// case here is a real event_type some route actually writes (grepped, not invented), so a
// passing suite proves the reader-facing label resolver matches what the audit trail contains.
describe('auditEventLabel — bespoke events (no composition rule applies)', () => {
  it('resolves a bespoke auth event', () => {
    const result = auditEventLabel('login_failed');
    expect(result).not.toBeNull();
    expect(result?.es).toBeTruthy();
    expect(result?.en).toBeTruthy();
  });

  it('resolves appointment_series_ended, which looks composable but is not (no "ended" CRUD suffix)', () => {
    expect(auditEventLabel('appointment_series_ended')).not.toBeNull();
  });

  it('resolves every bespoke event grepped from backend/src/routes', () => {
    const bespokeEvents = [
      'login_failed', 'login_success', 'logout', 'password_change_failed', 'password_changed',
      'password_reset', 'profile_updated', 'permission_denied', 'user_created', 'user_deactivated',
      'login_enabled', 'appointment_approved', 'appointment_rescheduled', 'appointment_patched',
      'appointment_action_denied', 'appointment_conflict_ignored', 'appointment_conflict_reflagged',
      'conflict_override', 'appointment_series_occurrence_materialized', 'appointment_series_ended',
      'ledger_write_denied', 'grant_denied', 'grant_created', 'grant_revoked', 'grant_listed',
      'closure_denied', 'closure_created', 'closure_updated', 'closure_deleted',
      'business_settings_updated',
    ];
    for (const eventType of bespokeEvents) {
      expect(auditEventLabel(eventType), eventType).not.toBeNull();
    }
  });
});

describe('auditEventLabel — composed from the generic CRUD suffix + table uiName', () => {
  it('composes a non-protected table create/update event without a hand-written entry', () => {
    const created = auditEventLabel('services_created');
    const updated = auditEventLabel('clients_updated');
    expect(created?.es).toContain(tableOf('services').uiName.es);
    expect(updated?.es).toContain(tableOf('clients').uiName.es);
  });

  it('also composes a protected table whose bespoke routes still name it tableKey_created/updated', () => {
    // appointment_series is protected (no generic CRUD) but its bespoke handlers emit event names
    // that happen to match the tableKey_suffix shape, so this still resolves without a hand entry.
    const created = auditEventLabel('appointment_series_created');
    expect(created?.es).toContain(tableOf('appointment_series').uiName.es);
  });
});

describe('auditEventLabel — composed from appointment_${state}', () => {
  it('composes every appointment state transition, including ones with a live route (requested, scheduled)', () => {
    for (const state of APPOINTMENT_STATES) {
      const result = auditEventLabel(`appointment_${state.value}`);
      expect(result?.es, state.value).toContain(state.label.es);
    }
  });
});

describe('auditEventLabel — composed from ledger_${entryType}_created', () => {
  it('composes every ledger entry type', () => {
    for (const entry of LEDGER_ENTRY_TYPES) {
      const result = auditEventLabel(`ledger_${entry.value}_created`);
      expect(result?.es, entry.value).toContain(entry.label.es);
    }
  });
});

describe('auditEventLabel — unresolved input', () => {
  it('returns null for an event type matching no bespoke entry and no composition rule', () => {
    expect(auditEventLabel('totally_unknown_event')).toBeNull();
  });

  it('returns null for the demo seed\'s fabricated event names that do not match the real vocabulary', () => {
    // seed-demo.ts writes cosmetic event_type strings ('appointment_created', 'appointment_update')
    // that no live route actually emits; the resolver must not accidentally decompose them.
    expect(auditEventLabel('appointment_created')).toBeNull();
    expect(auditEventLabel('appointment_update')).toBeNull();
  });
});
