import type { TableKey } from '../../shared/src/types/types';
import { fetchFullTable, fetchById, insertRow, updateRow, deleteRow } from './test_helpers';
import assert from 'node:assert';

export async function toGetAnEmptyTable(tableName: string) {
  const response = await fetchFullTable(tableName);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(Array.isArray(body.data), true);
  assert.strictEqual(body.data.length, 0);
  assert.strictEqual(body.meta.total, 0);
}

export async function tableContainsCount(tableName: string, count: number) {
  const response = await fetchFullTable(tableName);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.data.length, count);
  assert.strictEqual(body.meta.total, count);
  return body.data;
}

export async function insertedCorrectly(tableName: TableKey, row: Record<string, unknown>) {
  const response = await insertRow(tableName, row);
  assert.strictEqual(response.status, 201);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  for (const [key, value] of Object.entries(row)) {
    assert.deepEqual(body.data[key], value);
  }
  return body.data;
}

export async function fetchedByIdMatches(
  tableName: TableKey,
  id: string,
  expected: Record<string, unknown>,
  pkField: string = 'id',
) {
  const response = await fetchById(tableName, id, pkField);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(body.data[key], value);
  }
}

export async function updatedCorrectly(
  tableName: TableKey,
  id: string,
  row: Record<string, unknown>,
  pkField: string = 'id',
) {
  const response = await updateRow(tableName, id, row, pkField);
  assert.strictEqual(response.status, 202);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  for (const [key, value] of Object.entries(row)) {
    assert.deepEqual(body.data[key], value);
  }
  return body.data;
}

export async function deletedCorrectly(tableName: TableKey, id: string, pkField: string = 'id') {
  const response = await deleteRow(tableName, id, pkField);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.success, true);
}

export async function duplicateRejected(tableName: TableKey, row: Record<string, unknown>) {
  const response = await insertRow(tableName, row);
  assert.strictEqual(response.status, 409);
  const body = await response.json();
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'conflict');
}

export async function rejectedWith(response: globalThis.Response, status: number, code: string) {
  assert.strictEqual(response.status, status);
  const body = await response.json();
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, code);
}
