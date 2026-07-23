import type { Request } from 'express';
import { clampLimit, clampPage } from '../../../shared/src/ssot/list-protocol';
import type { ListSort, SortColumns } from '../db/sort';

export interface Pagination {
  limit: number;
  page: number;
  offset: number;
}

// Bespoke list-endpoint pagination, on the same shared policy as the generic engine: both parsers
// clamp through list-protocol so a hostile page or limit cannot mean one thing here and another
// on /api/:table.
export function parsePagination(query: Request['query']): Pagination {
  const limit = clampLimit(query.limit);
  const page = clampPage(query.page);
  const offset = (page - 1) * limit;
  return { limit, page, offset };
}

// Reads the shared `sort`/`dir` vocabulary against the endpoint's declared sortable columns. An
// unrecognised column falls back to the endpoint's default order instead of erroring, so a stale
// bookmark still renders its list; hasOwnProperty rather than `in`, so an inherited key like
// `constructor` can't pass as a column name.
export function parseListSort<C extends string>(
  query: Request['query'],
  columns: SortColumns<C>,
  fallback: ListSort<C>,
): ListSort<C> {
  const requested = String(query.sort ?? '');
  if (!Object.prototype.hasOwnProperty.call(columns, requested)) return fallback;
  const requestedDir = String(query.dir ?? '');
  return {
    column: requested as C,
    dir: requestedDir === 'asc' || requestedDir === 'desc' ? requestedDir : fallback.dir,
  };
}
