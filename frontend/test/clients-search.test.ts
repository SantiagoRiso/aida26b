import { describe, it, expect } from 'vitest';

// Mirrors ClientsView's search predicate so the name-or-DNI match is pinned without mounting the
// whole view: a query matches when it's a substring of either the display name or the DNI.
interface Row { display_name: string; dni: string | null }

function matches(row: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const matchesName = row.display_name.toLowerCase().includes(q);
  const matchesDni = (row.dni ?? '').toLowerCase().includes(q);
  return matchesName || matchesDni;
}

const rows: Row[] = [
  { display_name: 'Apu Nahasapeemapetilon', dni: '30440003' },
  { display_name: 'Bart Simpson', dni: '30440001' },
  { display_name: 'Selma Bouvier', dni: null },
];

describe('ClientsView search matches by name or DNI', () => {
  it('matches by name substring', () => {
    expect(rows.filter((r) => matches(r, 'bart')).map((r) => r.display_name)).toEqual(['Bart Simpson']);
  });

  it('matches by full DNI', () => {
    expect(rows.filter((r) => matches(r, '30440003')).map((r) => r.display_name)).toEqual([
      'Apu Nahasapeemapetilon',
    ]);
  });

  it('matches by DNI prefix', () => {
    expect(rows.filter((r) => matches(r, '3044000')).length).toBe(2);
  });

  it('tolerates a null DNI without matching', () => {
    expect(matches({ display_name: 'Selma Bouvier', dni: null }, '3044')).toBe(false);
  });

  it('returns everything for an empty query', () => {
    expect(rows.filter((r) => matches(r, '   ')).length).toBe(rows.length);
  });
});
