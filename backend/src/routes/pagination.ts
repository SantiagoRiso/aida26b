import type { Request } from 'express';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from '../../../shared/src/ssot/list-protocol';

export interface Pagination {
  limit: number;
  page: number;
  offset: number;
}

// Bespoke list-endpoint pagination, on the same shared policy as the generic engine.
export function parsePagination(query: Request['query']): Pagination {
  const limit = Math.min(Number(query.limit) || LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const page = Math.max(Number(query.page) || 1, 1);
  const offset = (page - 1) * limit;
  return { limit, page, offset };
}
