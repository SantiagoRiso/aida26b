import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../database/migrations');

const FILENAME_PATTERN = /^\d{8}_\d{6}_[a-z0-9_]+\.sql$/;

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function listMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory does not exist: ${dir}`);
  }
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const invalid = all.filter((f) => !FILENAME_PATTERN.test(f));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid migration filename(s):\n  - ${invalid.join('\n  - ')}\n` +
        `Expected format: YYYYMMDD_HHMMSS_lowercase_with_underscores.sql\n` +
        `Example: 20260520_120000_initial_schema.sql`
    );
  }
  return all.sort();
}

// Applied migrations are checksummed and immutable, so the checksum must depend only on the
// file's meaning, never on how the developer's Git checked it out. Git for Windows defaults to
// core.autocrlf=true, which would otherwise give a fresh clone CRLF files and a spurious
// "was modified after being applied" against a database migrated from an LF checkout.
export function normalizeSql(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

// A statement that opens, closes or aborts a transaction. Only ever matched at the start of a
// top-level statement, where these keywords are unambiguously transaction control (the same
// words inside a PL/pgSQL body are block structure, and that body is dollar-quoted).
// The trailing run covers the optional modifiers (WORK, ISOLATION LEVEL ..., AND CHAIN, ...)
// without spelling them out; excluding quotes, dollars and parentheses keeps the match from
// running past the statement if the keyword ever begins something else.
const TXN_CONTROL = /(?:BEGIN|START|COMMIT|END|ROLLBACK)\b[^;'"$()]*;/iy;

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

export interface SqlSpan {
  start: number;
  end: number;
  text: string;
}

function skipLineComment(sql: string, i: number): number {
  const nl = sql.indexOf('\n', i);
  return nl === -1 ? sql.length : nl + 1;
}

// Postgres block comments nest.
function skipBlockComment(sql: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < sql.length) {
    if (sql.startsWith('/*', j)) {
      depth++;
      j += 2;
    } else if (sql.startsWith('*/', j)) {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return sql.length;
}

// Handles the doubled-quote escape ('' inside '...', "" inside "...").
function skipQuoted(sql: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

// Returns the index past the closing tag, or -1 when this `$` does not open a dollar-quoted string.
function skipDollarQuoted(sql: string, i: number): number {
  DOLLAR_TAG.lastIndex = i;
  const open = DOLLAR_TAG.exec(sql);
  if (!open) return -1;
  const close = sql.indexOf(open[0], i + open[0].length);
  return close === -1 ? sql.length : close + open[0].length;
}

// Locates transaction-control statements at the top level of a migration file, ignoring the same
// keywords when they appear inside comments, string literals or dollar-quoted function bodies.
export function findTransactionControl(sql: string): SqlSpan[] {
  const spans: SqlSpan[] = [];
  let i = 0;
  let atStatementStart = true;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i = skipLineComment(sql, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
      continue;
    }

    if (atStatementStart) {
      TXN_CONTROL.lastIndex = i;
      const match = TXN_CONTROL.exec(sql);
      if (match) {
        spans.push({ start: i, end: i + match[0].length, text: match[0] });
        i += match[0].length;
        continue;
      }
    }

    if (ch === ';') {
      i++;
      atStatementStart = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '$') {
      const past = skipDollarQuoted(sql, i);
      i = past === -1 ? i + 1 : past;
    } else {
      i++;
    }
    atStatementStart = false;
  }

  return spans;
}

// The runner owns the transaction. A file's own COMMIT would commit the runner's transaction, so
// everything after it, including the schema_migrations bookkeeping, would run unprotected.
// Removing the statements keeps the whole file, and its ledger row, in one atomic unit.
export function stripTransactionControl(sql: string): { sql: string; removed: string[] } {
  const spans = findTransactionControl(sql);
  if (spans.length === 0) return { sql, removed: [] };

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    // Blanked in place rather than deleted so Postgres error positions still match the file.
    out += sql.slice(cursor, span.start) + span.text.replace(/[^\n]/g, ' ');
    cursor = span.end;
  }
  out += sql.slice(cursor);
  return { sql: out, removed: spans.map((s) => s.text) };
}

// The checksum covers the file as written (line endings normalized), not the executable text:
// it exists to detect edits to an applied migration, and stripping is an execution concern.
export function readMigration(dir: string, filename: string): { sql: string; checksum: string } {
  const normalized = normalizeSql(fs.readFileSync(path.join(dir, filename), 'utf8'));
  return { sql: stripTransactionControl(normalized).sql, checksum: sha256(normalized) };
}
