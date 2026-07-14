// The list-request wire protocol: one policy for every list endpoint (generic engine and
// bespoke routes alike), so a client can't get silently truncated by a stricter cap on one
// route than another.

export const FILTER_PREFIX = 'filter_';

export const RESERVED_LIST_PARAMS = ['page', 'sort', 'dir', 'limit'] as const;

export type ReservedListParam = (typeof RESERVED_LIST_PARAMS)[number];

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 500;

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
