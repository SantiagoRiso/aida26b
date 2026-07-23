// The list-request wire protocol: one policy for every list endpoint (generic engine and
// bespoke routes alike), so a client can't get silently truncated by a stricter cap on one
// route than another.

import type { ColumnDef } from '../types/types';

export const FILTER_PREFIX = 'filter_';

// Waives the viewer relevance narrowing a list may apply (see the clients list: staff see the
// people they have already worked with). It widens relevance only; what a viewer is allowed to
// read at all is never a request's decision.
export const INCLUDE_UNRELATED_PARAM = 'include_unrelated';
export const INCLUDE_UNRELATED_VALUE = '1';

export const RESERVED_LIST_PARAMS = ['page', 'sort', 'dir', 'limit', INCLUDE_UNRELATED_PARAM] as const;

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

// How a filter value is read, decided from the column's descriptor so the rule lives once and the
// request builder and the SQL compiler can't disagree about what a value means. An identity column
// holds an opaque token — a row id, or a member of a closed option list — matched whole; every
// other kind keeps its own value grammar.
export type FilterColumnKind = 'identity' | 'text' | 'boolean' | 'date' | 'number';

export function filterColumnKind(column: ColumnDef, isPk: boolean): FilterColumnKind {
  if (isPk || column.foreignKey || (column.options?.length ?? 0) > 0) return 'identity';
  if (column.type === 'boolean' || column.type === 'date' || column.type === 'number') return column.type;
  return 'text';
}

// A set literal: `1|2|3` means "any of these", and `!1|2|3` means none of them. Only identity
// columns read it as a set — repeated substring terms narrow a text search rather than widening
// it, and a set of booleans is the whole domain. The separator is deliberately not the comma the
// `min,max` range grammar owns, so no column kind can read one form as the other.
export const FILTER_SET_SEPARATOR = '|';

export function acceptsFilterSet(kind: FilterColumnKind): boolean {
  return kind === 'identity';
}

// One bind parameter per member, so an unbounded set would be unbounded planner work in a single
// request. Over the cap the compiler matches nothing: answering with a truncated set would look
// like a complete answer and quietly mislabel whatever fell off the end.
export const LIST_MAX_FILTER_SET = 100;

export function encodeFilterSet(values: readonly string[]): string {
  return values.join(FILTER_SET_SEPARATOR);
}

export function parseFilterSet(value: string): string[] {
  const members = new Set<string>();
  for (const part of value.split(FILTER_SET_SEPARATOR)) {
    const member = part.trim();
    if (member !== '') members.add(member);
  }
  return [...members];
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
  // (either bound may be blank), `a|b` is a set of ids or option values.
  filters?: Record<string, string>;
  includeUnrelated?: boolean;
}

export function listParamEntries(params: ListRequestParams): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  if (params.page && params.page > 1) entries.push(['page', String(params.page)]);
  if (params.limit) entries.push(['limit', String(params.limit)]);
  if (params.sort) entries.push(['sort', params.sort]);
  if (params.dir) entries.push(['dir', params.dir]);
  if (params.includeUnrelated) entries.push([INCLUDE_UNRELATED_PARAM, INCLUDE_UNRELATED_VALUE]);

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

// Page and limit are clamped identically wherever a list is parsed: the generic engine and the
// bespoke endpoints must not disagree about what a hostile value means. parseInt, not Number, so
// "2.5" truncates instead of reaching SQL as a fractional OFFSET and "1e15" reads as its leading
// digit; the floor of 1 keeps a negative from becoming a negative LIMIT, which Postgres rejects.
// eslint-disable-next-line no-restricted-syntax -- boundary: clamps a hostile query-string value of unverified shape; shared stays framework-agnostic so the Express query type isn't imported here
export function clampListBound(raw: unknown, fallback: number, max: number): number {
  const parsed = parseInt(String(raw ?? fallback), 10);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : fallback, max));
}

// eslint-disable-next-line no-restricted-syntax -- boundary: forwards a hostile query-string value of unverified shape to clampListBound
export function clampPage(raw: unknown): number {
  return clampListBound(raw, 1, LIST_MAX_PAGE);
}

// eslint-disable-next-line no-restricted-syntax -- boundary: forwards a hostile query-string value of unverified shape to clampListBound
export function clampLimit(raw: unknown): number {
  return clampListBound(raw, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
}

export interface ListRequestSpec {
  filters: ListFilterEntry[];
  sort?: string;
  dir: 'asc' | 'desc';
  page: number;
  limit: number;
  includeUnrelated: boolean;
}
