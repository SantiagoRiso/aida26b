import { i18n } from '@/i18n';
import { LEDGER_ENTRY_TYPES } from '@shared/ssot/domain/finance';
import { ledgerEntryName } from '@shared/ssot/domain/naming';
import { useLabel } from '@/composables/useLabel';
import { BADGE_TONE_CLASS } from '@/composables/badgeTone';
import type { LedgerEntry } from '@/api/ledger';

// The one place ledger entry types turn into a display label and a badge colour, so the ledger
// reads the same in the staff client detail and the client's own balance view.
export function useLedgerLabel() {
  const { label } = useLabel();

  function entryTypeLabel(value: string): string {
    const found = LEDGER_ENTRY_TYPES.find((t) => t.value === value);
    return found ? label(found.label) : value;
  }

  function entryBadgeClass(entryType: string): string {
    switch (entryType) {
      case 'charge': return BADGE_TONE_CLASS.danger;
      case 'payment': return BADGE_TONE_CLASS.success;
      case 'adjustment_credit': return BADGE_TONE_CLASS.info;
      // A debit adjustment raises what the client owes, so it warns without reading as a charge.
      case 'adjustment_debit': return BADGE_TONE_CLASS.warning;
      default: return BADGE_TONE_CLASS.neutral;
    }
  }

  // A typed description wins; the automatic session charge never has one, so most rows fall
  // through to naming the session the movement settles. client is omitted: both display sites
  // already sit inside one client's statement, so repeating the name would be noise.
  //
  // Only a charge always settles one session. A payment carries a turno only when a receptionist
  // took it; for anyone else it stays unallocated, which is what lets a payment be partial or cover
  // several sessions, and adjustments never carry one. Saying so beats an empty cell, which reads
  // as data we failed to load rather than a payment deliberately left on account.
  function entryDescription(entry: LedgerEntry): string {
    if (entry.description) return entry.description;
    return ledgerEntryName(
      { service: entry.service_name, professional: entry.professional_name, when: entry.appointment_when },
      i18n.global.t('ledger.unallocated'),
    );
  }

  return { entryTypeLabel, entryBadgeClass, entryDescription };
}
