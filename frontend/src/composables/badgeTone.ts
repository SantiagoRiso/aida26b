// One home for status badge colours so a given semantic reads identically wherever it appears —
// audit outcomes and ledger entry types share this palette instead of each restating the classes.
export const BADGE_TONE_CLASS = {
  success: 'bg-success-tint text-success-strong',
  danger: 'bg-destructive-tint text-destructive-strong',
  warning: 'bg-warning-tint text-warning-strong',
  info: 'bg-info-tint text-info-strong',
  neutral: 'bg-neutral-tint text-body',
} as const;

export type BadgeTone = keyof typeof BADGE_TONE_CLASS;

const AUDIT_OUTCOME_TONE: Record<string, BadgeTone> = {
  success: 'success',
  denied: 'danger',
  failure: 'warning',
};

export function auditOutcomeBadgeClass(outcome: string): string {
  return BADGE_TONE_CLASS[AUDIT_OUTCOME_TONE[outcome] ?? 'neutral'];
}
