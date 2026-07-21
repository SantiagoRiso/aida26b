import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DATE_RE } from '../src/time';

// The 'YYYY-MM-DD' shape used to be declared twice (backend/src/time.ts's DATE_RE and
// shared/src/ssot/domain/recurrence.ts's ISO_DATE_RE, byte-identical, nothing keeping them in
// sync) plus a third capture-group variant in frontend/src/composables/useCurrency.ts. All three
// now import the one definition (ISO_DATE_PATTERN) from shared/src/ssot/domain/availability.ts
// instead of re-declaring it. This is a structural check (is there still only one definition?),
// not a value-drift test — the project prefers single-sourcing a fact over policing two copies.

const availabilityPath = join(__dirname, '../../shared/src/ssot/domain/availability.ts');
const recurrencePath = join(__dirname, '../../shared/src/ssot/domain/recurrence.ts');
const timePath = join(__dirname, '../src/time.ts');
const useCurrencyPath = join(__dirname, '../../frontend/src/composables/useCurrency.ts');

// Backslashes and parens are stripped before matching so both a /regex literal/ and an
// equivalent '\\d{4}-...' string, capturing-group or not, are all counted as "the same fact".
function countAnchoredIsoDateLiteral(filePath: string): number {
  const raw = readFileSync(filePath, 'utf8');
  const normalized = raw.replace(/[\\()]/g, '');
  const needle = '^d{4}-d{2}-d{2}$';
  return normalized.split(needle).length - 1;
}

describe('ISO date regex has one definition, not two (or three)', () => {
  it('is declared exactly once, in the shared availability SSoT', () => {
    expect(countAnchoredIsoDateLiteral(availabilityPath)).toBe(1);
  });

  it('is imported (not re-declared) by backend/src/time.ts', () => {
    expect(countAnchoredIsoDateLiteral(timePath)).toBe(0);
    expect(readFileSync(timePath, 'utf8')).toContain('ISO_DATE_PATTERN');
  });

  it('is imported (not re-declared) by shared/src/ssot/domain/recurrence.ts', () => {
    expect(countAnchoredIsoDateLiteral(recurrencePath)).toBe(0);
    expect(readFileSync(recurrencePath, 'utf8')).toContain('ISO_DATE_PATTERN');
  });

  it('is imported (not re-declared) by the third copy found in frontend/src/composables/useCurrency.ts', () => {
    expect(countAnchoredIsoDateLiteral(useCurrencyPath)).toBe(0);
    expect(readFileSync(useCurrencyPath, 'utf8')).toContain('ISO_DATE_PATTERN');
  });

  it('DATE_RE still recognizes a plain calendar date and rejects a full ISO instant', () => {
    expect(DATE_RE.test('2026-07-20')).toBe(true);
    expect(DATE_RE.test('2026-07-20T00:00:00Z')).toBe(false);
    expect(DATE_RE.test('not-a-date')).toBe(false);
  });
});
