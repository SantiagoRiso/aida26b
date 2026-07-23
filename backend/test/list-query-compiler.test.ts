import { describe, test, expect } from 'vitest';
import { buildListStatement, buildRowStatement, type ListScope } from '../src/db/generic';
import { getTableKeys, getPkFields, tableOf } from '../../shared/src/utils/utils';
import type { TableKey } from '../../shared/src/ssot/derived';
import type { ListRequestSpec } from '../../shared/src/ssot/list-protocol';
import { encodeFilterSet, LIST_MAX_FILTER_SET } from '../../shared/src/ssot/list-protocol';

const noScope = (table: TableKey): ListScope => ({
  sqlTable: tableOf(table).sqlReadTable ?? tableOf(table).sqlTable ?? table,
  businessWhere: '',
  businessParams: [],
});

function spec(overrides: Partial<ListRequestSpec> = {}): ListRequestSpec {
  return { filters: [], dir: 'asc', page: 1, limit: 50, includeUnrelated: false, ...overrides };
}

function filterSpec(field: string, value: string, negated = false): ListRequestSpec {
  return spec({ filters: [{ field, values: [{ negated, value }] }] });
}

function selectList(sql: string): string[] {
  const match = /SELECT\s+(.+?)\s+FROM\s+\(/s.exec(sql);
  if (!match) throw new Error(`no outer SELECT list in: ${sql}`);
  return match[1]
    .split(',')
    .map((column) => column.trim())
    .filter((column) => !column.startsWith('COUNT('))
    .map((column) => column.replace(/^base\./, '').replace(/^"|"$/g, ''));
}

function orderBy(sql: string): string {
  return /ORDER BY\s+(.+?)\s*\n/.exec(sql)?.[1].trim() ?? '';
}

function whereClause(sql: string): string {
  return /WHERE\s+(.+?)\s*(?:ORDER BY|LIMIT|$)/s.exec(sql)?.[1].trim() ?? '';
}

// The read path selects from a physical source that carries more than the descriptor declares:
// auth.users behind clients/professionals holds credentials, and the tenant/role columns the scope
// predicates need are undeclared everywhere. A wildcard shipped all of them to the client.
describe('generic read projection', () => {
  for (const table of getTableKeys()) {
    test(`the list of ${table} projects only declared columns`, () => {
      const declared = Object.keys(tableOf(table).columns);
      const { dataQuery } = buildListStatement(table, spec(), noScope(table));

      expect(dataQuery).not.toMatch(/SELECT\s+base\.\*/);
      expect(selectList(dataQuery)).toEqual(declared);
    });

    test(`a single row of ${table} projects only declared columns`, () => {
      const declared = Object.keys(tableOf(table).columns);
      const pkValues = getPkFields(table).map(() => '1');
      const { text } = buildRowStatement(table, pkValues, noScope(table));

      expect(selectList(text)).toEqual(declared);
    });
  }

  test('the professionals list a Client reads never names a credential or tenancy column', () => {
    const { dataQuery } = buildListStatement('professionals', spec(), noScope('professionals'));

    for (const leaked of ['password_hash', 'password_salt', 'must_change_password', 'email', 'dni']) {
      expect(selectList(dataQuery)).not.toContain(leaked);
    }
  });

  test('the scope columns the outer query needs stay reachable inside the base query', () => {
    const { dataQuery } = buildListStatement('professionals', spec(), {
      sqlTable: 'auth.users_directory',
      businessWhere: '"business_id" = ?',
      businessParams: [7],
      discriminatorWhere: '"role" = ?',
      discriminatorParams: ['Professional'],
    });

    expect(dataQuery).toMatch(/SELECT \* FROM auth\.users_directory/);
    expect(whereClause(dataQuery)).toContain('"role" = $1');
    expect(whereClause(dataQuery)).toContain('"business_id" = $2');
  });
});

// Two LIMIT/OFFSET queries over a tied sort key are free to order the tied rows differently, so a
// page can repeat one row and never show another.
describe('list ordering', () => {
  test('a user-chosen sort column is closed by the pk', () => {
    const { dataQuery } = buildListStatement(
      'appointments',
      spec({ sort: 'state', dir: 'desc' }),
      noScope('appointments'),
    );

    expect(orderBy(dataQuery)).toBe('"state" DESC, "id" DESC');
  });

  test('the default sort is the pk alone, not repeated', () => {
    const { dataQuery } = buildListStatement('clients', spec(), noScope('clients'));

    expect(orderBy(dataQuery)).toBe('"id" ASC');
  });

  test('sorting on the pk itself does not duplicate it', () => {
    const { dataQuery } = buildListStatement('clients', spec({ sort: 'id' }), noScope('clients'));

    expect(orderBy(dataQuery)).toBe('"id" ASC');
  });

  test('every table ends its order on a unique key whatever column is chosen', () => {
    for (const table of getTableKeys()) {
      const sortable = Object.entries(tableOf(table).columns)
        .filter(([, column]) => column.sortable === true)
        .map(([name]) => name);

      for (const column of sortable) {
        const { dataQuery } = buildListStatement(table, spec({ sort: column }), noScope(table));
        const order = orderBy(dataQuery);
        const pk = getPkFields(table);

        for (const pkField of pk) {
          expect(order).toContain(`"${pkField}"`);
        }
      }
    }
  });
});

describe('boolean filters', () => {
  test('a boolean filter compiles to a bound predicate', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'users',
      filterSpec('is_active', 'false'),
      noScope('users'),
    );

    expect(whereClause(dataQuery)).toContain('"is_active" IS NOT DISTINCT FROM $1::boolean');
    expect(dataValues[0]).toBe(false);
  });

  test('excluding a boolean is the exact complement, so a null flag falls in one side', () => {
    const { dataQuery } = buildListStatement(
      'schedule_exceptions',
      filterSpec('is_unavailable', 'true', true),
      noScope('schedule_exceptions'),
    );

    expect(whereClause(dataQuery)).toContain('"is_unavailable" IS DISTINCT FROM $1::boolean');
  });

  test('a value that is not a boolean narrows to nothing instead of widening to everything', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'users',
      filterSpec('is_active', 'perhaps'),
      noScope('users'),
    );

    expect(whereClause(dataQuery)).toContain('1 = 0');
    expect(dataValues.slice(0, -2)).toEqual([]);
  });
});

describe('date filters', () => {
  test('a bare date names one calendar day in the business timezone', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'appointments',
      filterSpec('starts_at', '2026-07-21'),
      noScope('appointments'),
    );

    const where = whereClause(dataQuery);
    expect(where).toContain('"starts_at" >= ($1::date::timestamp AT TIME ZONE $2)');
    expect(where).toContain('"starts_at" < (($3::date + 1)::timestamp AT TIME ZONE $4)');
    expect(dataValues[0]).toBe('2026-07-21');
    expect(dataValues[2]).toBe('2026-07-21');
  });

  test('a date range uses the same min,max grammar as a numeric range', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'appointments',
      filterSpec('starts_at', '2026-07-01,2026-07-31'),
      noScope('appointments'),
    );

    expect(dataValues[0]).toBe('2026-07-01');
    expect(dataValues[2]).toBe('2026-07-31');
    expect(whereClause(dataQuery)).not.toContain('NOT (');
  });

  test('an open-ended range binds only the bound it was given', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'appointments',
      filterSpec('starts_at', '2026-07-01,'),
      noScope('appointments'),
    );

    expect(whereClause(dataQuery)).toContain('>=');
    expect(whereClause(dataQuery)).not.toContain('<');
    expect(dataValues[0]).toBe('2026-07-01');
  });

  test('excluding a date range negates the whole range, not one bound', () => {
    const { dataQuery } = buildListStatement(
      'appointments',
      filterSpec('starts_at', '2026-07-01,2026-07-31', true),
      noScope('appointments'),
    );

    expect(whereClause(dataQuery)).toContain('NOT (');
  });

  test('a value that is not a date narrows to nothing', () => {
    const { dataQuery } = buildListStatement(
      'appointments',
      filterSpec('starts_at', 'yesterday-ish'),
      noScope('appointments'),
    );

    expect(whereClause(dataQuery)).toContain('1 = 0');
  });
});

// An identity column names rows, so several values mean "any of these" — ANDing them the way a
// narrowing text search does can only ever match nothing.
describe('identity filters', () => {
  test('the pk matches exactly instead of as a substring', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'clients',
      filterSpec('id', '1'),
      noScope('clients'),
    );

    expect(whereClause(dataQuery)).toContain('"id" = $1');
    expect(dataQuery).not.toContain('ILIKE');
    expect(dataValues[0]).toBe('1');
  });

  test('a set of ids compiles to one bind parameter per member', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'clients',
      filterSpec('id', encodeFilterSet(['7', '9', '11'])),
      noScope('clients'),
    );

    expect(whereClause(dataQuery)).toContain('"id" IN ($1, $2, $3)');
    expect(dataValues.slice(0, 3)).toEqual(['7', '9', '11']);
  });

  test('excluding a set excludes every member', () => {
    const { dataQuery } = buildListStatement(
      'clients',
      filterSpec('id', encodeFilterSet(['7', '9']), true),
      noScope('clients'),
    );

    expect(whereClause(dataQuery)).toContain('"id" NOT IN ($1, $2)');
  });

  test('a repeated member is asked for once', () => {
    const { dataValues } = buildListStatement(
      'clients',
      filterSpec('id', encodeFilterSet(['7', '7', '9'])),
      noScope('clients'),
    );

    expect(dataValues.slice(0, -2)).toEqual(['7', '9']);
  });

  test('a set beyond the cap narrows to nothing rather than answering a truncated one', () => {
    const tooMany = Array.from({ length: LIST_MAX_FILTER_SET + 1 }, (_, n) => String(n + 1));
    const { dataQuery, dataValues } = buildListStatement(
      'clients',
      filterSpec('id', encodeFilterSet(tooMany)),
      noScope('clients'),
    );

    expect(whereClause(dataQuery)).toContain('1 = 0');
    expect(dataValues.slice(0, -2)).toEqual([]);
  });

  test('the cap itself is still answered', () => {
    const atCap = Array.from({ length: LIST_MAX_FILTER_SET }, (_, n) => String(n + 1));
    const { dataValues } = buildListStatement(
      'clients',
      filterSpec('id', encodeFilterSet(atCap)),
      noScope('clients'),
    );

    expect(dataValues.slice(0, -2)).toHaveLength(LIST_MAX_FILTER_SET);
  });

  test('an option column reads a set the same way', () => {
    const { dataQuery } = buildListStatement(
      'audit_events',
      filterSpec('outcome', encodeFilterSet(['failure', 'denied'])),
      noScope('audit_events'),
    );

    expect(whereClause(dataQuery)).toContain('"outcome" IN ($1, $2)');
  });

  test('a set on a foreign key still ANDs against a second filter on the same column', () => {
    const { dataQuery } = buildListStatement(
      'audit_events',
      spec({
        filters: [{
          field: 'actor_user_id',
          values: [
            { negated: false, value: encodeFilterSet(['3', '4']) },
            { negated: true, value: '4' },
          ],
        }],
      }),
      noScope('audit_events'),
    );

    expect(whereClause(dataQuery)).toContain('"actor_user_id" IN ($1, $2)');
    expect(whereClause(dataQuery)).toContain('"actor_user_id" != $3');
  });
});

// The set separator must not be readable as any other column kind's grammar.
describe('the set grammar belongs to identity columns alone', () => {
  test('a text search treats the separator as ordinary text', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'clients',
      filterSpec('display_name', 'ana|bruno'),
      noScope('clients'),
    );

    expect(whereClause(dataQuery)).toContain('ILIKE $1');
    expect(dataValues[0]).toBe('%ana|bruno%');
  });

  test('a numeric column keeps the comma range and reads no set', () => {
    const range = buildListStatement(
      'services',
      filterSpec('default_duration_minutes', '10,60'),
      noScope('services'),
    );
    expect(whereClause(range.dataQuery)).toContain('>=');
    expect(range.dataValues.slice(0, 2)).toEqual([10, 60]);

    // The separator is not part of the numeric grammar, so it never becomes a second bound.
    const asSet = buildListStatement(
      'services',
      filterSpec('default_duration_minutes', '10|60'),
      noScope('services'),
    );
    expect(whereClause(asSet.dataQuery)).not.toContain('IN (');
    expect(asSet.dataValues.slice(0, -2)).toEqual([10]);
  });
});

describe('numeric filters', () => {
  test('a value that is not a number narrows to nothing', () => {
    const { dataQuery } = buildListStatement(
      'services',
      filterSpec('default_duration_minutes', 'lots'),
      noScope('services'),
    );

    expect(whereClause(dataQuery)).toContain('1 = 0');
  });
});

// A bound LIKE pattern is not an injection risk, but an unescaped wildcard turns a search into a
// full scan that matches every row.
describe('text filters', () => {
  test('LIKE metacharacters are escaped and the escape is declared', () => {
    const { dataQuery, dataValues } = buildListStatement(
      'clients',
      filterSpec('display_name', '100%_off'),
      noScope('clients'),
    );

    expect(whereClause(dataQuery)).toContain("ILIKE $1 ESCAPE '\\'");
    expect(dataValues[0]).toBe('%100\\%\\_off%');
  });

  test('the escape character itself is escaped', () => {
    const { dataValues } = buildListStatement(
      'clients',
      filterSpec('display_name', 'a\\b'),
      noScope('clients'),
    );

    expect(dataValues[0]).toBe('%a\\\\b%');
  });
});
