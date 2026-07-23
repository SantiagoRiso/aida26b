// Ordering for the bespoke lists. They have no SSoT descriptor to derive a sortable-column set
// from, so each endpoint declares its own map of public sort name to SQL expression next to its
// query. Only a name present in that map ever reaches SQL — a request never contributes SQL text.

export interface ListSort<C extends string = string> {
  column: C;
  dir: 'asc' | 'desc';
}

export type SortColumns<C extends string> = Readonly<Record<C, string>>;

// The tiebreaker must be unique per row: rows tied on the sort column would otherwise come back in
// an unstable order, and paging would repeat one row while never showing another.
export function orderByClause<C extends string>(
  columns: SortColumns<C>,
  sort: ListSort<C>,
  tiebreaker: string,
): string {
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  return `${columns[sort.column]} ${dir}, ${tiebreaker} ${dir}`;
}
