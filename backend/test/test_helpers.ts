import { API_BASE } from './api_tests';

async function fetchFullTable(tableName: string) {
  try {
    return await fetch(`${API_BASE}/${tableName}`);
  } catch (error) {
    console.log(error);
    throw error;
  }
}

async function fetchById(tableName: string, id: string, pkField: string = 'id') {
  const queryParams = new URLSearchParams([[pkField, id]]).toString();
  try {
    return await fetch(`${API_BASE}/${tableName}?` + queryParams);
  } catch (error) {
    console.log(error);
    throw error;
  }
}

async function insertRow(tableName: string, row: Record<string, unknown>) {
  try {
    return await fetch(`${API_BASE}/${tableName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    });
  } catch (error) {
    console.log(error);
    throw error;
  }
}

async function updateRow(tableName: string, id: string, row: Record<string, unknown>, pkField: string = 'id') {
  const queryParams = new URLSearchParams([[pkField, id]]).toString();
  try {
    return await fetch(`${API_BASE}/${tableName}?` + queryParams, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    });
  } catch (error) {
    console.log(error);
    throw error;
  }
}

async function deleteRow(tableName: string, id: string, pkField: string = 'id') {
  const queryParams = new URLSearchParams([[pkField, id]]).toString();
  try {
    return await fetch(`${API_BASE}/${tableName}?` + queryParams, { method: 'DELETE' });
  } catch (error) {
    console.log(error);
    throw error;
  }
}

export { fetchFullTable, fetchById, insertRow, updateRow, deleteRow };
