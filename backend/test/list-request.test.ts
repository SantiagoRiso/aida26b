import { describe, test, expect } from 'vitest';
import { parseListRequest } from '../src/routes/list-request';
import { buildListStatement, type ListScope } from '../src/db/generic';
import { isKnownTable, assertCrudAllowed } from '../src/routes/crud-policy';
import type { AuthUser } from '../src/auth';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  filterParam,
  stripFilterPrefix,
  isReservedListParam,
  INCLUDE_UNRELATED_PARAM,
  INCLUDE_UNRELATED_VALUE,
  encodeFilterSet,
  parseFilterSet,
  filterColumnKind,
  acceptsFilterSet,
} from '../../shared/src/ssot/list-protocol';
import { tableOf, getPkFields } from '../../shared/src/utils/utils';

describe('list-protocol helpers', () => {
  test('filterParam and stripFilterPrefix are inverses', () => {
    expect(filterParam('name')).toBe('filter_name');
    expect(stripFilterPrefix(filterParam('name'))).toBe('name');
  });

  test('reserved list params are exactly page/sort/dir/limit/include_unrelated', () => {
    for (const key of ['page', 'sort', 'dir', 'limit', INCLUDE_UNRELATED_PARAM]) {
      expect(isReservedListParam(key)).toBe(true);
    }
    expect(isReservedListParam('id')).toBe(false);
    expect(isReservedListParam('filter_name')).toBe(false);
  });
});

describe('the set grammar', () => {
  test('encoding and parsing are inverses, blanks and repeats dropped', () => {
    expect(parseFilterSet(encodeFilterSet(['7', '9']))).toEqual(['7', '9']);
    expect(parseFilterSet('7||9| ')).toEqual(['7', '9']);
    expect(parseFilterSet('7|7')).toEqual(['7']);
    expect(parseFilterSet('')).toEqual([]);
  });

  test('only identity columns read a value as a set', () => {
    const kindOf = (table: 'clients' | 'sessions' | 'audit_events', field: string) =>
      filterColumnKind(tableOf(table).columns[field], getPkFields(table).includes(field));

    expect(kindOf('clients', 'id')).toBe('identity');
    expect(kindOf('sessions', 'user_id')).toBe('identity');
    expect(kindOf('audit_events', 'outcome')).toBe('identity');
    expect(kindOf('clients', 'display_name')).toBe('text');
    expect(kindOf('sessions', 'expires_at')).toBe('date');

    expect(acceptsFilterSet('identity')).toBe(true);
    expect(acceptsFilterSet('text')).toBe(false);
    expect(acceptsFilterSet('number')).toBe(false);
    expect(acceptsFilterSet('date')).toBe(false);
    expect(acceptsFilterSet('boolean')).toBe(false);
  });

  test('the set separator is not the one the range grammar already owns', () => {
    expect(parseFilterSet('10,60')).toEqual(['10,60']);
  });
});

describe('parseListRequest', () => {
  test('empty query yields policy defaults', () => {
    const spec = parseListRequest({});
    expect(spec).toEqual({
      filters: [],
      sort: undefined,
      dir: 'asc',
      page: 1,
      limit: LIST_DEFAULT_LIMIT,
      includeUnrelated: false,
    });
  });

  test('the relevance waiver is opt-in and only in its exact form', () => {
    expect(parseListRequest({ [INCLUDE_UNRELATED_PARAM]: INCLUDE_UNRELATED_VALUE }).includeUnrelated).toBe(true);
    expect(parseListRequest({ [INCLUDE_UNRELATED_PARAM]: '0' }).includeUnrelated).toBe(false);
    expect(parseListRequest({}).includeUnrelated).toBe(false);
  });

  test('limit is capped at the shared max and floored at 1', () => {
    expect(parseListRequest({ limit: '9999' }).limit).toBe(LIST_MAX_LIMIT);
    expect(parseListRequest({ limit: '-5' }).limit).toBe(1);
  });

  test('non-numeric limit and page fall back to defaults', () => {
    expect(parseListRequest({ limit: 'abc' }).limit).toBe(LIST_DEFAULT_LIMIT);
    expect(parseListRequest({ page: 'abc' }).page).toBe(1);
  });

  test('page is clamped to [1, 1000]', () => {
    expect(parseListRequest({ page: '0' }).page).toBe(1);
    expect(parseListRequest({ page: '5000' }).page).toBe(1000);
  });

  test('lexes the ! negation marker off filter values', () => {
    const spec = parseListRequest({ filter_role: '!Client' });
    expect(spec.filters).toEqual([
      { field: 'role', values: [{ negated: true, value: 'Client' }] },
    ]);
  });

  test('range syntax passes through untouched — interpretation is the compiler\'s', () => {
    const spec = parseListRequest({ filter_price: '10,60' });
    expect(spec.filters).toEqual([
      { field: 'price', values: [{ negated: false, value: '10,60' }] },
    ]);
  });

  test('repeated filter params keep every value', () => {
    const spec = parseListRequest({ filter_state: ['requested', '!cancelled'] });
    expect(spec.filters).toEqual([
      {
        field: 'state',
        values: [
          { negated: false, value: 'requested' },
          { negated: true, value: 'cancelled' },
        ],
      },
    ]);
  });

  test('empty filter values and non-filter keys are dropped', () => {
    const spec = parseListRequest({ filter_name: '', id: '7', sort: 'name' });
    expect(spec.filters).toEqual([]);
    expect(spec.sort).toBe('name');
  });

  test('array-valued sort and dir take the first value', () => {
    const spec = parseListRequest({ sort: ['name', 'id'], dir: ['desc', 'asc'] });
    expect(spec.sort).toBe('name');
    expect(spec.dir).toBe('desc');
  });
});

// The generic engine closes the injection surface by construction (every user value is a bind
// param; every interpolated identifier comes from a descriptor-derived allowlist), but nothing
// asserted that until now. These tests exercise the real compiler (buildListStatement,
// db/generic.ts) and authz gate (crud-policy.ts) with hostile input end to end from the parsed
// request spec — not just that the parser lexes it, but that the SQL text it produces never
// carries the payload.
describe('SQL injection surface is closed by construction, not convention', () => {
  // No business/owner/grant scope in play — isolates the assertions to the filter/sort compiler.
  const noScope: ListScope = { sqlTable: 'auth.users_directory', businessWhere: '', businessParams: [] };
  const admin: AuthUser = {
    id: 1,
    username: 'probe',
    email: null,
    role: 'Admin',
    business_id: null,
    is_active: true,
    must_change_password: false,
  };

  test('a hostile filter value is carried as a bind parameter, never spliced into SQL text', () => {
    const payload = "x'; DROP TABLE appointments; --";
    const spec = parseListRequest({ filter_display_name: payload });
    const { dataQuery, dataValues } = buildListStatement('clients', spec, noScope);

    expect(dataQuery).not.toContain('DROP TABLE');
    expect(dataQuery).not.toContain(payload);
    expect(dataQuery).toMatch(/"display_name"::text ILIKE \$1/);
    expect(dataValues).toContain(`%${payload}%`);
  });

  test('every member of a set is a bind parameter, not spliced into the IN list', () => {
    const payload = "1); DROP TABLE clients; --";
    const spec = parseListRequest({ filter_id: encodeFilterSet(['7', payload]) });
    const { dataQuery, dataValues } = buildListStatement('clients', spec, noScope);

    expect(dataQuery).not.toContain('DROP TABLE');
    expect(dataQuery).not.toContain(payload);
    expect(dataQuery).toMatch(/"id" IN \(\$1, \$2\)/);
    expect(dataValues.slice(0, 2)).toEqual(['7', payload]);
  });

  test('a set naming an unregistered column is dropped like any other unknown field', () => {
    const hostileField = `id"); DROP TABLE clients; --`;
    const spec = parseListRequest({ [filterParam(hostileField)]: encodeFilterSet(['1', '2']) });
    const { dataQuery, dataValues } = buildListStatement('clients', spec, noScope);

    expect(dataQuery).not.toContain('DROP TABLE');
    expect(dataQuery).not.toContain(hostileField);
    expect(dataValues).toEqual([LIST_DEFAULT_LIMIT, 0]);
  });

  test('a hostile sort value is rejected by the allowlist, not interpolated into ORDER BY', () => {
    const spec = parseListRequest({ sort: 'id; DROP TABLE clients' });
    const { dataQuery } = buildListStatement('clients', spec, noScope);

    expect(dataQuery).not.toContain('DROP TABLE');
    // Not in getSortableColumns('clients') as an exact string -> falls back to the pk default.
    expect(dataQuery).toMatch(/ORDER BY "id" ASC/);
  });

  test('a filter naming an unregistered column is dropped, never used as a SQL identifier', () => {
    const hostileField = `notes"); DROP TABLE clients; --`;
    const spec = parseListRequest({ [filterParam(hostileField)]: 'anything' });
    const { dataQuery, dataValues } = buildListStatement('clients', spec, noScope);

    // Only the base projection's own (unrelated) soft-delete WHERE is present — no filter
    // condition was appended after it, so the hostile field name was never made into SQL text.
    expect(dataQuery).not.toContain('DROP TABLE');
    expect(dataQuery).not.toContain(hostileField);
    expect(dataQuery).toMatch(/\) AS base\s*\n\s*ORDER BY/);
    // Only the default limit/offset bind params — no filter value was carried through either.
    expect(dataValues).toEqual([LIST_DEFAULT_LIMIT, 0]);
  });

  test('a real but non-filterable column is refused the same way as an unknown one', () => {
    // `notes` exists on clients but is declared filterable:false — must be silently ignored,
    // not silently promoted to a queryable identifier.
    const spec = parseListRequest({ filter_notes: 'anything' });
    const { dataQuery, dataValues } = buildListStatement('clients', spec, noScope);

    // `notes` is a declared column so it appears in the projection; what must never happen is it
    // becoming a predicate.
    expect(dataQuery).not.toMatch(/"notes"\s*(::text)?\s*(ILIKE|IS|[<>=])/);
    expect(dataQuery).toMatch(/\) AS base\s*\n\s*ORDER BY/);
    expect(dataValues).toEqual([LIST_DEFAULT_LIMIT, 0]);
  });

  test('limit and page are clamped to safe integers and reach SQL only as bind params', () => {
    const spec = parseListRequest({ limit: '99999; DROP TABLE clients', page: '2; DROP TABLE clients' });

    // parseInt reads the leading digits; the clamp is what actually neutralizes an out-of-range value.
    expect(spec.limit).toBe(LIST_MAX_LIMIT);
    expect(spec.page).toBe(2);

    const { dataQuery, dataValues } = buildListStatement('clients', spec, noScope);
    expect(dataQuery).not.toContain('DROP TABLE');
    expect(dataQuery).toMatch(/LIMIT \$\d+\s+OFFSET \$\d+/);
    expect(dataValues.slice(-2)).toEqual([LIST_MAX_LIMIT, (spec.page - 1) * LIST_MAX_LIMIT]);
  });

  test('an unknown or hostile table name never reaches the compiler — 404 without leaking existence', () => {
    expect(isKnownTable('widgets')).toBe(false);
    expect(isKnownTable("clients'; DROP TABLE clients; --")).toBe(false);

    const result = assertCrudAllowed("clients'; DROP TABLE clients; --", 'read', admin);
    expect(result).toEqual({
      ok: false,
      status: 404,
      code: 'not_found',
      message: expect.any(String),
    });
  });
});
