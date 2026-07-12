import type { Pool, PoolClient } from 'pg';
import { types } from 'pg';
import { structure } from '../../../shared/src/ssot/structure';
import type { TableKey, TableRecordMap, ColumnDef, SqlParam } from '../../../shared/src/types/types';
import { DbError } from './errors';

// pg parses DATE (OID 1082) into a JS Date, which serialises to an ISO timestamp with a trailing Z
// on the wire — shifting the calendar day under any non-UTC client and breaking bare-'YYYY-MM-DD'
// consumers (schedule exceptions). Keep DATE verbatim, consistent with the rest of the wire
// contract (NUMERIC/BIGINT already pass through as strings).
types.setTypeParser(types.builtins.DATE, (v) => v);

export type Queryable = Pool | PoolClient;

export async function query<T>(db: Queryable, sql: string, params?: SqlParam[]): Promise<T[]> {
  try {
    const result = await db.query(sql, params);
    return result.rows as T[];
  } catch (e) {
    throw DbError.from(e);
  }
}

export async function queryOne<T>(db: Queryable, sql: string, params?: SqlParam[]): Promise<T | null> {
  const rows = await query<T>(db, sql, params);
  return rows[0] ?? null;
}

// Own the BEGIN/COMMIT/ROLLBACK/release lifecycle so handlers never hand-roll it.
export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    // Rethrow unchanged: driver errors are already DbError (wrapped in query()), and
    // app errors carry their own semantics (e.g. structured {status} loader errors) that
    // the caller translates — wrapping here would erase them.
    throw e;
  } finally {
    client.release();
  }
}

// SSoT row-mapper: coerce a raw pg row into the table's declared record type. pg returns
// BIGINT/NUMERIC as strings and DATE/TIMESTAMP as strings-or-Date; the declared column type
// is the single authority for how each value is shaped. Keys absent from the row are omitted.
// eslint-disable-next-line no-restricted-syntax -- raw pg row: shape is unknown until coerced against the SSoT column map below
export function toRecord<T extends TableKey>(table: T, row: Record<string, unknown>): TableRecordMap[T] {
  const columns = structure.tables[table].columns as Record<string, ColumnDef>;
  // eslint-disable-next-line no-restricted-syntax -- output accumulator mirrors the same not-yet-typed row shape before the final cast to TableRecordMap[T]
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(columns)) {
    if (!(name in row)) continue;
    const value = row[name];
    if (value == null) {
      out[name] = null;
      continue;
    }
    switch (col.type) {
      case 'number':
        out[name] = Number(value);
        break;
      case 'date':
        out[name] = value instanceof Date ? value : new Date(value as string);
        break;
      case 'boolean':
        out[name] = typeof value === 'boolean' ? value : Boolean(value);
        break;
      default:
        out[name] = value;
    }
  }
  return out as TableRecordMap[T];
}
