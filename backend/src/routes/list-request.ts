import type express from 'express';
import {
  clampLimit,
  clampPage,
  INCLUDE_UNRELATED_PARAM,
  INCLUDE_UNRELATED_VALUE,
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

  const page = clampPage(firstOf(query.page));
  const limit = clampLimit(firstOf(query.limit));

  const includeUnrelated = firstOf(query[INCLUDE_UNRELATED_PARAM]) === INCLUDE_UNRELATED_VALUE;

  return { filters, sort, dir, page, limit, includeUnrelated };
}
