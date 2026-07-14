// One home for status badge colours so a given semantic reads identically wherever it appears —
// audit outcomes and ledger entry types share this palette instead of each restating the classes.
export const BADGE_TONE_CLASS = {
  success: 'bg-green-100 text-success',
  danger: 'bg-red-100 text-destructive',
  warning: 'bg-yellow-100 text-warning',
  info: 'bg-blue-100 text-blue-700',
  accent: 'bg-amber-100 text-amber-700',
  neutral: 'bg-slate-100 text-neutral',
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
