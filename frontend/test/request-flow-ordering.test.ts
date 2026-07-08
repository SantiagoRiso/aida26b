import { describe, it, expect } from 'vitest';

// Mirrors RequestFlow.vue's professionalOptions comparator so the ordering rule for #5 is
// pinned without mounting the whole step flow: professionals seen most recently (within a year)
// come first (most recent → oldest), then everyone else alphabetically by display name.
interface Ranked { label: string; recency: number | null }

function order(items: Ranked[]): string[] {
  return [...items]
    .sort((a, b) => {
      if (a.recency != null && b.recency != null) return b.recency - a.recency;
      if (a.recency != null) return -1;
      if (b.recency != null) return 1;
      return a.label.localeCompare(b.label);
    })
    .map((i) => i.label);
}

describe('RequestFlow professional ordering (recency then alphabetical)', () => {
  it('places professionals with recent history before those without', () => {
    const result = order([
      { label: 'Dr. Zoidberg', recency: null },
      { label: 'Dra. Marge Bouvier', recency: 1_000 },
    ]);
    expect(result[0]).toBe('Dra. Marge Bouvier');
  });

  it('orders those with history most-recent first', () => {
    const result = order([
      { label: 'Older', recency: 100 },
      { label: 'Newer', recency: 900 },
    ]);
    expect(result).toEqual(['Newer', 'Older']);
  });

  it('orders professionals with no history alphabetically', () => {
    const result = order([
      { label: 'Dra. Edna Krabappel', recency: null },
      { label: 'Dr. Arnie Pye', recency: null },
      { label: 'Dr. Ned Flanders', recency: null },
    ]);
    expect(result).toEqual(['Dr. Arnie Pye', 'Dr. Ned Flanders', 'Dra. Edna Krabappel']);
  });

  it('combines both rules: recent block (recency order) then alphabetical block', () => {
    const result = order([
      { label: 'Beto', recency: null },
      { label: 'Ana', recency: null },
      { label: 'Recent A', recency: 500 },
      { label: 'Recent B', recency: 800 },
    ]);
    expect(result).toEqual(['Recent B', 'Recent A', 'Ana', 'Beto']);
  });
});
