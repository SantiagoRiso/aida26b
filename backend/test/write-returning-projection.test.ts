import { describe, it, expect } from 'vitest';
import {
  buildInsertStatement,
  buildUpdateStatement,
  buildDeleteStatement,
} from '../src/db/generic';
import {
  getTableKeys,
  getPkFields,
  getNotDerivableFields,
  getWriteProtectedColumns,
  tableOf,
} from '../../shared/src/utils/utils';
import type { TableKey } from '../../shared/src/ssot/derived';
import type { ScopeConditionsInput } from '../src/db/scope';

const noScope: ScopeConditionsInput = { businessWhere: '', businessParams: [] };

function physicalTableOf(table: TableKey): string {
  return tableOf(table).sqlTable ?? table;
}

function returningColumns(sql: string): string[] {
  const match = /RETURNING\s+(.+?)\s*$/s.exec(sql.trim());
  if (!match) throw new Error(`no RETURNING clause in: ${sql}`);
  return match[1].split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
}

function writeStatements(table: TableKey): string[] {
  const pkFields = getPkFields(table);
  const editable = getNotDerivableFields(table).filter((field) => !pkFields.includes(field));
  const statements = [
    buildDeleteStatement(table, physicalTableOf(table), pkFields, ['1'], noScope, 1).text,
    buildInsertStatement(physicalTableOf(table), editable, editable.map(() => null), table).text,
  ];

  // A table whose every column is the pk or server-derived has nothing to SET, and the update
  // route rejects it before building a statement.
  if (editable.length > 0) {
    statements.push(
      buildUpdateStatement(
        table,
        physicalTableOf(table),
        editable,
        editable.map(() => null),
        pkFields,
        ['1'],
        noScope,
      ).text,
    );
  }

  return statements;
}

// Writes hit the raw table (auth.users), not the secret-free view reads go through, so a
// wildcard projection ships credentials to the client. The projection is pinned to the
// descriptor for every table, not to a list of column names to suppress.
describe('generic write RETURNING projection', () => {
  for (const table of getTableKeys()) {
    it(`projects only declared columns for ${table}`, () => {
      const declared = Object.keys(tableOf(table).columns);

      for (const sql of writeStatements(table)) {
        expect(sql).not.toMatch(/RETURNING\s+\*/);
        expect(returningColumns(sql)).toEqual(declared);
      }
    });

    it(`never returns a privileged column for ${table}`, () => {
      const declared = new Set(Object.keys(tableOf(table).columns));
      const privileged = [...getWriteProtectedColumns(physicalTableOf(table))].filter(
        (column) => !declared.has(column),
      );

      for (const sql of writeStatements(table)) {
        for (const column of privileged) {
          expect(returningColumns(sql)).not.toContain(column);
        }
      }
    });
  }

  it('covers the credential columns on the table clients and professionals write to', () => {
    const privileged = getWriteProtectedColumns('auth.users');
    expect(privileged.has('password_hash')).toBe(true);
    expect(privileged.has('password_salt')).toBe(true);

    for (const table of ['clients', 'professionals'] as const) {
      const declared = Object.keys(tableOf(table).columns);
      expect(declared).not.toContain('password_hash');
      expect(declared).not.toContain('password_salt');
    }
  });
});
