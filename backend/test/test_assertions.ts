import type { TableKey } from '../../shared/src/types/types';
import { getEntityName } from '../src/helpers';
import { fetchFullTable, fetchById, insertRow, updateRow, deleteRow } from './test_helpers';
import assert from 'node:assert';

// The generic list endpoint answers { data, total } with no success/message.
export async function toGetAnEmptyTable(tableName: string) {
  const response = await fetchFullTable(tableName);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(Array.isArray(body.data), true);
  assert.strictEqual(body.data.length, 0);
  assert.strictEqual(body.total, 0);
}

export async function tableContainsCount(tableName: string, count: number) {
  const response = await fetchFullTable(tableName);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.data.length, count);
  assert.strictEqual(body.total, count);
  return body.data;
}

// Inserts a row, asserts the success envelope, and returns the created row (with its id).
export async function insertedCorrectly(tableName: TableKey, row: Record<string, unknown>) {
  const response = await insertRow(tableName, row);
  assert.strictEqual(response.status, 201);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.message, `${getEntityName(tableName)} created successfully`);
  for (const [key, value] of Object.entries(row)) {
    assert.deepEqual(body.data[key], value);
  }
  return body.data;
}

export async function fetchedByIdMatches(tableName: TableKey, id: string, expected: Record<string, unknown>) {
  const response = await fetchById(tableName, id);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.message, `${getEntityName(tableName)} fetched successfully`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(body.data[key], value);
  }
}

export async function updatedCorrectly(tableName: TableKey, id: string, row: Record<string, unknown>) {
  const response = await updateRow(tableName, id, row);
  assert.strictEqual(response.status, 202);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.message, `${getEntityName(tableName)} updated successfully`);
  for (const [key, value] of Object.entries(row)) {
    assert.deepEqual(body.data[key], value);
  }
  return body.data;
}

export async function deletedCorrectly(tableName: TableKey, id: string) {
  const response = await deleteRow(tableName, id);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.message, `${getEntityName(tableName)} deleted successfully`);
}

export async function duplicateRejected(tableName: TableKey, row: Record<string, unknown>) {
  const response = await insertRow(tableName, row);
  assert.strictEqual(response.status, 409);
  const body = await response.json();
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.message, `${getEntityName(tableName)} already exists`);
}
