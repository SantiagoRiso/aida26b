import type { SqlParam } from './core';
import { BUSINESS_TZ, DATE_RE } from '../time';

// A date-only filter bound names a calendar day as the user sees it, so it must be resolved in the
// business timezone and date_to must cover the whole of that day, not just its first instant.
// Postgres does the zone math from BUSINESS_TZ so no offset is copied here. A caller that sends a
// full ISO instant means that exact instant and passes through unchanged.
export function dateBoundConditions(
  column: string,
  bounds: { from?: string; to?: string },
  startIndex: number,
): { conditions: string[]; params: SqlParam[]; nextIndex: number } {
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  let p = startIndex;

  if (bounds.from != null) {
    if (DATE_RE.test(bounds.from)) {
      conditions.push(`${column} >= ($${p++}::date::timestamp AT TIME ZONE $${p++})`);
      params.push(bounds.from, BUSINESS_TZ);
    } else {
      conditions.push(`${column} >= $${p++}`);
      params.push(bounds.from);
    }
  }

  if (bounds.to != null) {
    if (DATE_RE.test(bounds.to)) {
      conditions.push(`${column} < (($${p++}::date + 1)::timestamp AT TIME ZONE $${p++})`);
      params.push(bounds.to, BUSINESS_TZ);
    } else {
      conditions.push(`${column} <= $${p++}`);
      params.push(bounds.to);
    }
  }

  return { conditions, params, nextIndex: p };
}
