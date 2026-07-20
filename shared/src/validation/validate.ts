import { structure } from '../ssot/structure';
import { getPkFields } from '../utils/utils';
import type { ColumnDef, ColumnValue } from '../types/types';
import type { TableKey, TableRecordMap } from '../ssot/derived';

export type FieldErrors = Record<string, string>;

export type ParseResult<T extends TableKey> =
  | { data: TableRecordMap[T] }
  | { fields: FieldErrors };

const regexCache = new Map<string, RegExp>();
function getRegex(source: string): RegExp {
  let re = regexCache.get(source);
  if (!re) { re = new RegExp(source); regexCache.set(source, re); }
  return re;
}

// Booking-window and cancellation-cutoff rules are per-tenant and runtime-computed
// (see backend/src/services/scheduling.ts and shared/src/ssot/domain/appointment-lifecycle.ts) —
// they can't be expressed as static descriptor bounds, so this only checks the value parses as a date.
function checkDate(key: string, value: ColumnValue | undefined): string | undefined {
  const parsed = new Date(value as string);
  if (isNaN(parsed.getTime())) return `${key} must be a valid date`;
  return undefined;
}

function checkValue(key: string, col: ColumnDef, value: ColumnValue | undefined): string | undefined {
  const v = col.validator ?? {};

  switch (col.type) {
    case 'string':
      if (typeof value !== 'string') return `${key} must be a string`;
      break;
    case 'number':
      if (typeof value !== 'number' || isNaN(value)) return `${key} must be a number`;
      if (v.integer && !Number.isInteger(value)) return `${key} must be an integer`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${key} must be a boolean`;
      break;
  }

  if (col.type === 'date' || col.input === 'date') {
    const dateError = checkDate(key, value);
    if (dateError) return dateError;
  }

  if (col.options && !col.options.some((o) => o.value === value)) {
    return `${key} must be one of: ${col.options.map((o) => o.value).join(', ')}`;
  }

  if (v.pattern && (typeof value !== 'string' || !getRegex(v.pattern).test(value))) {
    return v.patternMessage ? `${key} ${v.patternMessage}` : `${key} has an invalid format`;
  }

  if (typeof value === 'string') {
    if (typeof v.minLength === 'number' && value.length < v.minLength) return `${key} must be at least ${v.minLength} characters`;
    if (typeof v.maxLength === 'number' && value.length > v.maxLength) return `${key} must be at most ${v.maxLength} characters`;
  }
  if (typeof value === 'number') {
    if (typeof v.minValue === 'number' && value < v.minValue) return `${key} must be >= ${v.minValue}`;
    if (typeof v.maxValue === 'number' && value > v.maxValue) return `${key} must be <= ${v.maxValue}`;
  }

  return undefined;
}

function normalizeValue(col: ColumnDef, value: ColumnValue | undefined): ColumnValue | undefined {
  const norm = col.validator?.normalize;
  return norm && typeof value === 'string'
    ? value.replace(getRegex(norm.pattern), norm.replacement)
    : value;
}

// Columns a client may set when creating a row: everything not server-owned (editable !== false),
// including readonlyOnEdit columns (settable once, at create).
function editableColumns(table: TableKey): string[] {
  return Object.entries(structure.tables[table].columns as Record<string, ColumnDef>)
    .filter(([, col]) => col.editable !== false)
    .map(([key]) => key);
}

// Columns a client may set when updating: the creatable set minus columns frozen after create.
// readonlyOnEdit marks identity-ish fields (e.g. a link table's FK pair) — settable at create,
// immutable thereafter (reassignment is remove + add, not an update). Exported so the UPDATE
// statement builder consumes the same set validateForUpdate accepts — the two can't drift.
export function updatableColumns(table: TableKey): string[] {
  return Object.entries(structure.tables[table].columns as Record<string, ColumnDef>)
    .filter(([, col]) => col.editable !== false && !col.readonlyOnEdit)
    .map(([key]) => key);
}

function isEmpty(col: ColumnDef, value: ColumnValue | undefined): boolean {
  return value === null || value === undefined || (col.type === 'string' && value === '');
}

export function validateField(table: TableKey, column: string, value: ColumnValue | undefined): string | undefined {
  const col = (structure.tables[table].columns as Record<string, ColumnDef>)[column];
  if (!col) return `${column} is not a valid field`;
  if (isEmpty(col, value)) return col.validator?.required ? `${column} is required` : undefined;
  return checkValue(column, col, value);
}

// `data` must hold exactly `fields` - nothing missing, nothing extra - with every value valid.
// The declared class states intent; HTTP callers hand us unverified bodies, so every field is
// still checked at runtime.
function validate<T extends TableKey>(table: T, data: Partial<TableRecordMap[T]>, fields: string[]): ParseResult<T> {
  const columns = structure.tables[table].columns as Record<string, ColumnDef>;
  const obj = (data != null && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, ColumnValue | undefined>;
  const allowed = new Set(fields);
  const fieldErrors: FieldErrors = {};
  const out: Record<string, ColumnValue> = {};

  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fieldErrors[key] = `${key} is not an allowed field`;
  }

  for (const key of fields) {
    const col = columns[key];
    if (!col) { fieldErrors[key] = `${key} is not a valid field`; continue; }
    if (!(key in obj)) { fieldErrors[key] = `${key} is required`; continue; }

    const raw = obj[key];
    const error = validateField(table, key, raw);
    if (error) { fieldErrors[key] = error; continue; }
    // checkValue already enforced the column's primitive type; safe to narrow.
    out[key] = isEmpty(col, raw) ? null : (normalizeValue(col, raw) as ColumnValue);
  }

  return Object.keys(fieldErrors).length > 0
    ? { fields: fieldErrors }
    : { data: out as TableRecordMap[T] };
}

export const validateFullObject = <T extends TableKey>(table: T, data: Partial<TableRecordMap[T]>): ParseResult<T> =>
  validate(table, data, editableColumns(table));

// Update-mode validation: rejects (and never requires) readonlyOnEdit columns, so a link table's
// identity FKs cannot be reassigned through a generic PUT.
export const validateForUpdate = <T extends TableKey>(table: T, data: Partial<TableRecordMap[T]>): ParseResult<T> =>
  validate(table, data, updatableColumns(table));

export const validateOnlyPk = <T extends TableKey>(table: T, data: Partial<TableRecordMap[T]>): ParseResult<T> =>
  validate(table, data, getPkFields(table));
