import type express from 'express';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  isFilterParam,
  stripFilterPrefix,
} from '../../../shared/src/ssot/list-protocol';
import type {
  ListFilterEntry,
  ListFilterValue,
  ListRequestSpec,
} from '../../../shared/src/ssot/list-protocol';

export type { ListRequestSpec };

function firstOf<T>(param: T | T[]): T | undefined {
  return Array.isArray(param) ? param[0] : param;
}

// Decodes the list-request query grammar (filter_ prefix, `!` negation, sort/dir/page/limit
// clamping) into a typed spec. Unknown filter fields are kept here — the compiler drops the
// ones the descriptor doesn't declare filterable.
export function parseListRequest(query: express.Request['query']): ListRequestSpec {
  const filters: ListFilterEntry[] = [];

  for (const [key, rawValue] of Object.entries(query)) {
    if (!isFilterParam(key) || rawValue == null || rawValue === '') {
      continue;
    }

    const field = stripFilterPrefix(key);
    const vals = Array.isArray(rawValue) ? rawValue : [rawValue];
    const values: ListFilterValue[] = [];

    for (const v of vals) {
      const strVal = String(v);

      if (!strVal) {
        continue;
      }

      const negated = strVal.startsWith('!');
      values.push({ negated, value: negated ? strVal.slice(1) : strVal });
    }

    filters.push({ field, values });
  }

  const requestedSort = firstOf(query.sort);
  const sort = typeof requestedSort === 'string' ? requestedSort : undefined;

  const dir: 'asc' | 'desc' = firstOf(query.dir) === 'desc' ? 'desc' : 'asc';

  const page = Math.max(
    1,
    Math.min(parseInt(String(firstOf(query.page) || '1'), 10) || 1, 1000),
  );

  const requestedLimit = firstOf(query.limit);
  const limit = Math.max(
    1,
    Math.min(
      parseInt(String(requestedLimit || LIST_DEFAULT_LIMIT), 10) || LIST_DEFAULT_LIMIT,
      LIST_MAX_LIMIT,
    ),
  );

  return { filters, sort, dir, page, limit };
}
