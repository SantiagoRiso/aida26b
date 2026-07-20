// The list-request wire protocol: one policy for every list endpoint (generic engine and
// bespoke routes alike), so a client can't get silently truncated by a stricter cap on one
// route than another.

export const FILTER_PREFIX = 'filter_';

export const RESERVED_LIST_PARAMS = ['page', 'sort', 'dir', 'limit'] as const;

export type ReservedListParam = (typeof RESERVED_LIST_PARAMS)[number];

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 500;
export const LIST_MAX_PAGE = 1000;

export function isReservedListParam(key: string): key is ReservedListParam {
  return (RESERVED_LIST_PARAMS as readonly string[]).includes(key);
}

export function isFilterParam(key: string): boolean {
  return key.startsWith(FILTER_PREFIX);
}

export function filterParam(field: string): string {
  return `${FILTER_PREFIX}${field}`;
}

export function stripFilterPrefix(key: string): string {
  return key.slice(FILTER_PREFIX.length);
}

// Request-side counterpart of the parser: the single place that decides which keys a list
// request carries and which values are omitted (page 1, blank filters). Every producer — the
// API call and the shareable URL alike — goes through it, so the two can't drift apart.
export interface ListRequestParams {
  page?: number;
  limit?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  // Per-field filter values: `text` matches, `!text` excludes, `min,max` is a numeric range
  // (either bound may be blank).
  filters?: Record<string, string>;
}

export function listParamEntries(params: ListRequestParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  if (params.page && params.page > 1) entries.push(['page', String(params.page)]);
  if (params.limit) entries.push(['limit', String(params.limit)]);
  if (params.sort) entries.push(['sort', params.sort]);
  if (params.dir) entries.push(['dir', params.dir]);

  for (const [field, value] of Object.entries(params.filters ?? {})) {
    if (value !== '' && value !== undefined) entries.push([filterParam(field), value]);
  }

  return entries;
}

// The parsed form of a list request. A single filter value carries the `!` negation marker
// already lexed off; whether the value is then read as free text, an id, or a `min,max` range
// depends on the column's declared type — that interpretation belongs to the SQL compiler,
// not the transport parser.
export interface ListFilterValue {
  negated: boolean;
  value: string;
}

export interface ListFilterEntry {
  field: string;
  values: ListFilterValue[];
}

export interface ListRequestSpec {
  filters: ListFilterEntry[];
  sort?: string;
  dir: 'asc' | 'desc';
  page: number;
  limit: number;
}
