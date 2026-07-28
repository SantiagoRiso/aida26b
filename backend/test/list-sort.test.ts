import { describe, test, expect } from 'vitest';
import { parseListSort } from '../src/routes/pagination';
import { orderByClause } from '../src/db/sort';
import { AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT } from '../src/db/audit';
import { LEDGER_SORT_COLUMNS, LEDGER_DEFAULT_SORT } from '../src/db/ledger';
import { APPOINTMENT_SORT_COLUMNS, APPOINTMENT_DEFAULT_SORT } from '../src/db/appointments';
import {
  AUDIT_SORT_FIELDS,
  LEDGER_SORT_FIELDS,
  APPOINTMENT_SORT_FIELDS,
} from '../../shared/src/ssot/list-sort';

describe('parseListSort', () => {
  test('a declared column is accepted with the requested direction', () => {
    expect(parseListSort({ sort: 'outcome', dir: 'asc' }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT))
      .toEqual({ column: 'outcome', dir: 'asc' });
  });

  test('a declared column with no direction takes the endpoint default direction', () => {
    expect(parseListSort({ sort: 'event_type' }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT))
      .toEqual({ column: 'event_type', dir: AUDIT_DEFAULT_SORT.dir });
  });

  test('an undeclared column falls back whole, direction included', () => {
    expect(parseListSort({ sort: 'ip', dir: 'asc' }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT))
      .toEqual(AUDIT_DEFAULT_SORT);
  });

  test('a garbage direction on a declared column falls back to the default direction', () => {
    expect(parseListSort({ sort: 'outcome', dir: 'sideways' }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT))
      .toEqual({ column: 'outcome', dir: AUDIT_DEFAULT_SORT.dir });
  });

  test('no sort at all is the endpoint default', () => {
    expect(parseListSort({}, LEDGER_SORT_COLUMNS, LEDGER_DEFAULT_SORT)).toEqual(LEDGER_DEFAULT_SORT);
  });

  // A prototype member is not a declared column; reading it would put a function where a SQL
  // fragment belongs.
  test('an inherited key is not a column name', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(parseListSort({ sort: key }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT)).toEqual(AUDIT_DEFAULT_SORT);
    }
  });

  test('a repeated sort key arrives as an array and is not read as a column', () => {
    expect(parseListSort({ sort: ['outcome', 'ip'] }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT))
      .toEqual(AUDIT_DEFAULT_SORT);
  });

  // Whatever a request contains, the column half of the result is always one the endpoint declared.
  test('SQL injection through the sort parameter never survives the parse', () => {
    const hostile = ["a.id; DROP TABLE audit_events", "1) OR 1=1 --", "a.created_at DESC, (SELECT 1)"];
    for (const value of hostile) {
      const parsed = parseListSort({ sort: value }, AUDIT_SORT_COLUMNS, AUDIT_DEFAULT_SORT);
      expect(parsed).toEqual(AUDIT_DEFAULT_SORT);
      expect(orderByClause(AUDIT_SORT_COLUMNS, parsed, 'a.id')).not.toContain(value);
    }
  });
});

describe('orderByClause', () => {
  test('carries the declared expression and closes with the tiebreaker', () => {
    expect(orderByClause(AUDIT_SORT_COLUMNS, { column: 'created_at', dir: 'desc' }, 'a.id'))
      .toBe('a.created_at DESC, a.id DESC');
    expect(orderByClause(LEDGER_SORT_COLUMNS, { column: 'amount_ars', dir: 'asc' }, 'id'))
      .toBe('le.amount_ars ASC, id ASC');
  });

  // Rows tied on the sort column would otherwise come back in an unstable order, and paging would
  // repeat one row while never showing another.
  test('every sortable column of every bespoke list ends in a unique tiebreaker', () => {
    for (const column of AUDIT_SORT_FIELDS) {
      expect(orderByClause(AUDIT_SORT_COLUMNS, { column, dir: 'asc' }, 'a.id')).toMatch(/, a\.id ASC$/);
    }
    for (const column of LEDGER_SORT_FIELDS) {
      expect(orderByClause(LEDGER_SORT_COLUMNS, { column, dir: 'desc' }, 'id')).toMatch(/, id DESC$/);
    }
    for (const column of APPOINTMENT_SORT_FIELDS) {
      expect(orderByClause(APPOINTMENT_SORT_COLUMNS, { column, dir: 'asc' }, 'a.id')).toMatch(/, a\.id ASC$/);
    }
  });
});

// The shared declaration is what the views gate their URL against; the SQL maps are what the
// endpoints order by. If one gains a column the other does not, a screen offers an order the
// server silently ignores.
describe('the declared sortable columns and the SQL maps agree', () => {
  test('each bespoke list maps exactly its declared columns', () => {
    expect(Object.keys(AUDIT_SORT_COLUMNS).sort()).toEqual([...AUDIT_SORT_FIELDS].sort());
    expect(Object.keys(LEDGER_SORT_COLUMNS).sort()).toEqual([...LEDGER_SORT_FIELDS].sort());
    expect(Object.keys(APPOINTMENT_SORT_COLUMNS).sort()).toEqual([...APPOINTMENT_SORT_FIELDS].sort());
  });

  test('each default order names a declared column', () => {
    expect(AUDIT_SORT_FIELDS).toContain(AUDIT_DEFAULT_SORT.column);
    expect(LEDGER_SORT_FIELDS).toContain(LEDGER_DEFAULT_SORT.column);
    expect(APPOINTMENT_SORT_FIELDS).toContain(APPOINTMENT_DEFAULT_SORT.column);
  });
});
