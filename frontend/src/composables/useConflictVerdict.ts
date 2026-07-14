import type { ConflictVerdict, Conflict } from '@shared/ssot/domain/conflict';
import { i18n } from '@/i18n';

// The API never builds a display string; localization is the frontend's responsibility.
// Uses the global i18n instance (not useI18n()) — this composable is invoked directly in
// tests and outside component setup, where the composition-mode composable isn't available.

const CONFLICT_KEYS: Record<string, string> = {
  professional_overlap: 'conflicts.professionalOverlap',
  resource_overlap: 'conflicts.resourceOverlap',
  professional_availability: 'conflicts.professionalAvailability',
  resource_availability: 'conflicts.resourceAvailability',
  requested_block: 'conflicts.requestedBlock',
  slot_alignment: 'conflicts.slotAlignment',
};

export interface ConflictDescription {
  lines: string[];
  canOverride: boolean;
}

export function useConflictVerdict() {
  function describeConflict(c: Conflict): string {
    const key = CONFLICT_KEYS[c.type];
    if (!key) return i18n.global.t('conflicts.fallback', { type: c.type, entity: c.entity.name });
    return i18n.global.t(key, { entity: c.entity.name, start: c.range.start, end: c.range.end });
  }

  function describe(verdict: ConflictVerdict): ConflictDescription {
    return {
      lines: verdict.conflicts.map(describeConflict),
      canOverride: verdict.can_override,
    };
  }

  return { describe };
}
