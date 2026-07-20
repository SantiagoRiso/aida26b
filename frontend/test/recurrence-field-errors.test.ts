import { describe, it, expect } from 'vitest';
import { i18n } from '@/i18n';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { validateRecurrenceRuleIssues, type RecurrenceRuleFields } from '@shared/ssot/domain/recurrence';
import { defaultRecurrenceState, validateRecurrenceFields, type RecurrenceState } from '@/composables/seriesRule';

// seriesRule.ts used to flatten every rule violation to the same generic-required prose,
// discarding whichever specific rule the shared validator actually named. These tests pin the
// specific fieldError.<key> message through instead — against the real i18n singleton, the same
// path a server-rejected save resolves through (fieldErrorMessage), not a hardcoded string.
i18n.global.locale.value = 'es';

describe('validateRecurrenceFields — specific message survives, not the generic fallback', () => {
  it('a missing weekday under weekly frequency reads the weekday-specific message', () => {
    const state: RecurrenceState = { ...defaultRecurrenceState(), frequency: 'weekly', weekday: '' };
    const errors = validateRecurrenceFields(state);
    expect(errors.weekday).toBe(es.fieldError.recurrenceWeekdayRequired);
    expect(errors.weekday).not.toBe(es.fieldError.required);
    expect(errors.weekday).not.toBe(es.fieldError.fallback);
  });

  it('an out-of-range week_of_month reads the interpolated 1..5 message', () => {
    const state: RecurrenceState = {
      ...defaultRecurrenceState(),
      frequency: 'monthly_dow',
      weekday: 'mon',
      week_of_month: '9',
    };
    const errors = validateRecurrenceFields(state);
    expect(errors.week_of_month).toBe(es.fieldError.recurrenceWeekOfMonthRange.replace('{min}', '1').replace('{max}', '5'));
    expect(errors.week_of_month).not.toBe(es.fieldError.fallback);
  });

  it('end_kind=count with no end_count reads the count-specific message', () => {
    const state: RecurrenceState = {
      ...defaultRecurrenceState(),
      frequency: 'weekly',
      weekday: 'mon',
      end_kind: 'count',
      end_count: '',
    };
    const errors = validateRecurrenceFields(state);
    expect(errors.end_count).toBe(es.fieldError.recurrenceEndCountRequired);
  });

  it('a valid rule reports no field errors at all', () => {
    const state: RecurrenceState = { ...defaultRecurrenceState(), frequency: 'weekly', weekday: 'mon' };
    expect(validateRecurrenceFields(state)).toEqual({});
  });
});

// Every key the shared recurrence validator can hand to fieldErrorMessage must resolve in both
// languages — a key present only in one bundle would silently fall back to the generic message
// (or the raw key) in the other, exactly the drift this task closes.
describe('recurrence field-error keys: es/en parity', () => {
  const NEW_KEYS = [
    'recurrenceFrequencyInvalid',
    'recurrenceIntervalInvalid',
    'recurrenceWeekdayRequired',
    'recurrenceFieldNotApplicable',
    'recurrenceWeekOfMonthRange',
    'recurrenceDayOfMonthRange',
    'recurrenceEndKindInvalid',
    'recurrenceEndCountRequired',
    'recurrenceEndFieldNotApplicable',
    'recurrenceEndDateBeforeStart',
    'recurrenceInvalid',
  ] as const;

  it('every recurrence key is defined, non-empty, in both es and en', () => {
    for (const key of NEW_KEYS) {
      expect(es.fieldError[key], `es.fieldError.${key}`).toBeTruthy();
      expect(en.fieldError[key], `en.fieldError.${key}`).toBeTruthy();
    }
  });

  it('every key the validator actually emits across a representative sweep of rules is in NEW_KEYS or an existing shared key', () => {
    const base: RecurrenceRuleFields = {
      frequency: 'weekly',
      interval: 1,
      weekday: 'mon',
      week_of_month: null,
      day_of_month: null,
      start_time: '10:00',
      start_date: '2026-07-20',
      end_kind: 'count',
      end_count: 4,
      end_date: null,
    };
    const sweeps: Partial<RecurrenceRuleFields>[] = [
      { frequency: 'nope' },
      { interval: 0 },
      { weekday: null },
      { week_of_month: 2 },
      { frequency: 'monthly_dow', week_of_month: 9 },
      { frequency: 'monthly_dom', weekday: null, day_of_month: 45 },
      { end_kind: 'nope' },
      { end_count: null },
      { end_date: '2026-08-01' },
      { end_kind: 'until', end_count: null, end_date: null },
      { end_kind: 'until', end_count: null, end_date: '2026-01-01' },
      { end_kind: 'open', end_count: 3 },
    ];
    const seenKeys = new Set<string>();
    for (const patch of sweeps) {
      const issues = validateRecurrenceRuleIssues({ ...base, ...patch });
      for (const issue of Object.values(issues)) seenKeys.add(issue.key);
    }
    for (const key of seenKeys) {
      expect(es.fieldError[key as keyof typeof es.fieldError], key).toBeTruthy();
      expect(en.fieldError[key as keyof typeof en.fieldError], key).toBeTruthy();
    }
    // Confirms the sweep actually exercised the new domain-specific keys, not just generic ones.
    expect([...seenKeys].some((k) => NEW_KEYS.includes(k as (typeof NEW_KEYS)[number]))).toBe(true);
  });
});
