import { LEDGER_ENTRY_TYPES } from '@shared/ssot/domain/finance';
import { useLabel } from '@/composables/useLabel';
import { BADGE_TONE_CLASS } from '@/composables/badgeTone';

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

  return { entryTypeLabel, entryBadgeClass };
}
