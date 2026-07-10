import { LEDGER_ENTRY_TYPES } from '@shared/ssot/domain/finance';
import { useLabel } from '@/composables/useLabel';

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
      case 'charge': return 'bg-red-100 text-destructive';
      case 'payment': return 'bg-green-100 text-success';
      case 'adjustment_credit': return 'bg-blue-100 text-blue-700';
      case 'adjustment_debit': return 'bg-amber-100 text-amber-700';
      default: return 'bg-slate-100 text-neutral';
    }
  }

  return { entryTypeLabel, entryBadgeClass };
}
