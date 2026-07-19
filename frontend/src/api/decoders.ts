import { structure } from '@shared/ssot/structure';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';

export type Decoder<T> = (value: unknown) => value is T;

export const unknownValue: Decoder<unknown> = (_value): _value is unknown => true;
export const undefinedValue: Decoder<undefined> = (value): value is undefined => value === undefined;
export const stringValue: Decoder<string> = (value): value is string => typeof value === 'string';
export const numberValue: Decoder<number> = (value): value is number => typeof value === 'number' && Number.isFinite(value);
export const booleanValue: Decoder<boolean> = (value): value is boolean => typeof value === 'boolean';

export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return (value): value is T | null => value === null || decoder(value);
}

export function optional<T>(decoder: Decoder<T>): Decoder<T | undefined> {
  return (value): value is T | undefined => value === undefined || decoder(value);
}

export function literal<const T extends string | number | boolean | null>(expected: T): Decoder<T> {
  return (value): value is T => value === expected;
}

export function union<A, B>(a: Decoder<A>, b: Decoder<B>): Decoder<A | B> {
  return (value): value is A | B => a(value) || b(value);
}

export function object<T>(shape: { [K in keyof T]-?: Decoder<T[K]> }): Decoder<T> {
  return (value): value is T => {
    if (!isUnknownRecord(value)) return false;
    for (const key in shape) {
      if (!shape[key](value[key])) return false;
    }
    return true;
  };
}

export function stringEnum<const T extends string>(values: readonly T[]): Decoder<T> {
  return (value): value is T => typeof value === 'string' && values.some((candidate) => candidate === value);
}

export function arrayOf<T>(item: Decoder<T>): Decoder<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every(item);
}

export function recordOf<T>(item: Decoder<T>): Decoder<Record<string, T>> {
  return (value): value is Record<string, T> => isUnknownRecord(value) && Object.values(value).every(item);
}

function isWireColumnValue(type: string, value: unknown): boolean {
  if (type === 'date') return typeof value === 'string';
  return typeof value === type;
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function tableRecord<K extends TableKey>(table: K): Decoder<Wire<TableRecordMap[K]>> {
  return (value): value is Wire<TableRecordMap[K]> => {
    if (!isUnknownRecord(value)) return false;
    for (const [name, column] of Object.entries(structure.tables[table].columns)) {
      const field = value[name];
      if (field === null && column.validator?.nullable === true) continue;
      if (!isWireColumnValue(column.type, field)) return false;
    }
    return true;
  };
}
