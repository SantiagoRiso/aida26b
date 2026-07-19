import { structure } from '@shared/ssot/structure';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import { isUnknownRecord, type Decoder } from '@/api/decoders';

// eslint-disable-next-line no-restricted-syntax -- Column value is narrowed according to its SSoT descriptor.
function isWireColumnValue(type: string, value: unknown): boolean {
  if (type === 'date') return typeof value === 'string';
  return typeof value === type;
}

export function tableRecord<K extends TableKey>(table: K): Decoder<Wire<TableRecordMap[K]>> {
  // eslint-disable-next-line no-restricted-syntax -- Generated table guard validates an untrusted response row.
  const guard = (value: unknown): value is Wire<TableRecordMap[K]> => {
    if (!isUnknownRecord(value)) return false;
    for (const [name, column] of Object.entries(structure.tables[table].columns)) {
      const field = value[name];
      if (field === null && column.validator?.nullable === true) continue;
      if (!isWireColumnValue(column.type, field)) return false;
    }
    return true;
  };
  return Object.assign(guard, {
    // eslint-disable-next-line no-restricted-syntax -- Diagnostics inspect the same untrusted response row.
    explain(value: unknown, path = '$'): string | null {
      if (!isUnknownRecord(value)) return `${path}: expected object`;
      for (const [name, column] of Object.entries(structure.tables[table].columns)) {
        const field = value[name];
        if (field === null && column.validator?.nullable === true) continue;
        if (!isWireColumnValue(column.type, field)) {
          return `${path}.${name}: expected ${column.type === 'date' ? 'ISO date string' : column.type}`;
        }
      }
      return null;
    },
  });
}
