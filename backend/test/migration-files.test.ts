import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_MIGRATIONS_DIR,
  findTransactionControl,
  listMigrationFiles,
  normalizeSql,
  readMigration,
  sha256,
  stripTransactionControl,
} from '../src/migration-files';

function removed(sql: string): string[] {
  return stripTransactionControl(sql).removed.map((s) => s.replace(/\s+/g, ' ').trim());
}

test('strip: removes top-level transaction control in all its spellings', () => {
  assert.deepEqual(removed('BEGIN;\nCREATE TABLE a (id INT);\nCOMMIT;'), ['BEGIN;', 'COMMIT;']);
  assert.deepEqual(removed('START TRANSACTION;\nSELECT 1;\nEND;'), ['START TRANSACTION;', 'END;']);
  assert.deepEqual(removed('begin transaction;\nrollback work;'), [
    'begin transaction;',
    'rollback work;',
  ]);
  assert.deepEqual(removed('BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE;'), [
    'BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE;',
  ]);
});

test('strip: leaves the rest of the file byte-identical, with line numbers intact', () => {
  const sql = 'BEGIN;\nCREATE TABLE a (id INT);\nCOMMIT;\n';
  const out = stripTransactionControl(sql).sql;
  assert.equal(out, '      \nCREATE TABLE a (id INT);\n       \n');
  assert.equal(out.length, sql.length);
});

test('strip: ignores BEGIN/END inside a PL/pgSQL body, a string literal or a comment', () => {
  const fn = [
    'CREATE FUNCTION f() RETURNS TRIGGER AS $$',
    'BEGIN',
    '  RETURN NEW;',
    'END',
    '$$ LANGUAGE plpgsql;',
  ].join('\n');
  assert.deepEqual(removed(fn), []);

  const doBlock = "DO $do$\nBEGIN\n  EXECUTE 'GRANT SELECT ON t TO r';\nEND\n$do$;";
  assert.deepEqual(removed(doBlock), []);

  assert.deepEqual(removed("INSERT INTO t (note) VALUES ('COMMIT;');"), []);
  assert.deepEqual(removed('-- COMMIT;\n/* BEGIN; */\nSELECT 1;'), []);
});

test('strip: a statement merely starting with a similar word is untouched', () => {
  assert.deepEqual(removed('CREATE TABLE beginning (id INT);'), []);
  assert.deepEqual(removed('SELECT commit_id FROM t;'), []);
});

test('checksum: identical for a CRLF and an LF checkout of the same file', () => {
  const lf = 'CREATE TABLE a (\n  id INT\n);\n';
  assert.equal(sha256(normalizeSql(lf.replace(/\n/g, '\r\n'))), sha256(normalizeSql(lf)));
});

test('checksum: unchanged by the stripping, so applied migrations stay immutable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migfiles-'));
  try {
    const body = 'BEGIN;\nCREATE TABLE a (id INT);\nCOMMIT;\n';
    fs.writeFileSync(path.join(dir, '20260101_120000_a.sql'), body);
    const { sql, checksum } = readMigration(dir, '20260101_120000_a.sql');
    assert.equal(checksum, sha256(body));
    assert.equal(sql.includes('BEGIN'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The repository's own migrations are the real input; a parser bug here would silently mangle
// production DDL rather than fail loudly.
test('strip: every real migration keeps its non-transaction statements intact', () => {
  for (const file of listMigrationFiles(DEFAULT_MIGRATIONS_DIR)) {
    const raw = normalizeSql(
      fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), 'utf8')
    );
    const { sql, removed: found } = stripTransactionControl(raw);
    assert.equal(sql.length, raw.length, `${file}: stripping changed offsets`);
    for (const stmt of found) {
      assert.match(stmt, /^(BEGIN|START|COMMIT|END|ROLLBACK)/i, `${file}: removed "${stmt}"`);
    }
    assert.deepEqual(findTransactionControl(sql), [], `${file}: transaction control survived`);

    const ddl = /\b(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|COMMENT|DO)\b/gi;
    assert.equal(
      (sql.match(ddl) ?? []).length,
      (raw.match(ddl) ?? []).length,
      `${file}: stripping consumed a real statement`
    );
  }
});
