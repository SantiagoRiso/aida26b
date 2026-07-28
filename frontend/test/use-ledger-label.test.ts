import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useLedgerLabel } from '@/composables/useLedgerLabel';
import { es } from '@/i18n/es';
import type { LedgerEntry } from '@/api/ledger';

// Only a charge always settles one session. A payment carries a turno only when a receptionist
// took it (for Admin and Professional it stays unallocated, so a payment can be partial or cover
// several sessions), and adjustments never carry one. Most non-charge rows have no appointment to
// name them by, and that is the case worth pinning.
function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: '1',
    client_user_id: '1',
    appointment_id: null,
    entry_type: 'charge',
    amount_ars: '1000.00',
    description: null,
    actor_user_id: null,
    created_at: '2026-01-01T12:00:00.000Z',
    ...overrides,
  } as LedgerEntry;
}

const LINKED = { service_name: 'Sesión', professional_name: 'Dra. Bouvier', appointment_when: '06/07 10:00' };
const UNLINKED = { service_name: null, professional_name: null, appointment_when: null };

describe('useLedgerLabel: entryDescription', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('a typed description wins over the derived name, even when appointment parts are present', () => {
    const { entryDescription } = useLedgerLabel();
    expect(entryDescription(entry({ description: 'Pago manual en efectivo', ...LINKED })))
      .toBe('Pago manual en efectivo');
  });

  it('a null description derives the name from service, professional, and when', () => {
    const { entryDescription } = useLedgerLabel();
    expect(entryDescription(entry({ description: null, ...LINKED })))
      .toBe('Sesión - Dra. Bouvier · 06/07 10:00');
  });

  it('a receptionist payment names the session it settles, exactly as its charge does', () => {
    const { entryDescription } = useLedgerLabel();
    const charge = entryDescription(entry({ entry_type: 'charge', appointment_id: '7', ...LINKED }));
    const payment = entryDescription(entry({ entry_type: 'payment', appointment_id: '7', ...LINKED }));
    expect(payment).toBe(charge);
  });

  it('a null description with only some parts present drops the missing ones without a dangling separator', () => {
    const { entryDescription } = useLedgerLabel();
    expect(entryDescription(entry({ description: null, ...UNLINKED, service_name: 'Sesión' })))
      .toBe('Sesión');
  });

  // The empty cell this replaces read as data we failed to load, when it is really a payment
  // deliberately left on account.
  it('an unallocated payment says so instead of rendering blank', () => {
    const { entryDescription } = useLedgerLabel();
    expect(entryDescription(entry({ entry_type: 'payment', description: null, ...UNLINKED })))
      .toBe(es.ledger.unallocated);
  });

  it('an adjustment, which never carries a turno, is labelled the same way', () => {
    const { entryDescription } = useLedgerLabel();
    for (const entry_type of ['adjustment_credit', 'adjustment_debit']) {
      expect(entryDescription(entry({ entry_type, description: null, ...UNLINKED })))
        .toBe(es.ledger.unallocated);
    }
  });

  it('an empty-string description is treated as absent, not as a typed value', () => {
    const { entryDescription } = useLedgerLabel();
    expect(entryDescription(entry({ description: '', ...UNLINKED, service_name: 'Sesión' })))
      .toBe('Sesión');
  });
});
