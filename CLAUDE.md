# CLAUDE.md

Operating guide for working in this repo. These reflect how the maintainer wants
work done — follow them by default.

## Working agreement: commits and review

- **Do the work, but do not commit.** Leave all changes in the working tree.
- **Staging is the maintainer's approval.** They run `git add` on files once they've
  reviewed and accepted them. Treat staged files as locked: do not re-edit, unstage,
  revert, stash, or commit them, and never run `git add`/`commit`/`reset`/`checkout --`
  on their behalf unless explicitly asked.
- **No automatic version bumps** and no per-task commit churn.
- **Work in small units and stop for review** between them, rather than running a
  long batch end to end.

## Comments and code style

- **Terse. Business rationale only.** A comment should explain a non-obvious domain
  reason ("users are deactivated, never deleted"), not restate what the code does.
- **No process references in code** — no phase numbers, decision/ADR IDs, or ticket
  numbers. Those live in planning docs, not the codebase.
- **Let the code self-document.** Prefer clear names and structure over commentary;
  delete a comment the code already makes obvious.

## Database and migrations

- **Prefer a clean schema baseline over create-then-drop churn.** Don't create
  something a later step immediately drops; build the schema you actually want.
- **Order tables by dependency.** Create a referenced (parent) table before the
  tables that reference it, so foreign keys are declared inline rather than patched
  in afterward with `ALTER TABLE`.
- **Least-privilege roles.** A schema-owner role owns the database and objects and is
  what migrations run as; the application role receives only explicit, per-table
  grants. Enforce immutable / append-only tables by withholding `UPDATE`/`DELETE`
  rather than relying on application code alone.
- **Share connection config across roles.** Owner and app connections target the same
  host/port/database; only the credentials differ — don't introduce parallel,
  divergeable copies of the same value.

## General approach

- **Optimize for correctness, not simplicity-by-omission.** If a simpler option
  sacrifices correctness, say so and recommend the correct one.
- **Surface downstream consequences.** When a change creates work or a constraint for
  a later step, call it out explicitly instead of letting it surface later.
- **Confirm before consequential or destructive actions**, and **verify** (type-check,
  tests) before claiming something is done.

---

# Backend architecture

Multi-tenant (per `business_id`) appointment system. Express 4 + `pg` + Postgres;
Argentina-only, ARS-only. **Core idea: generic CRUD, authz, and scoping are generated at
runtime from one SSoT object; workflow-owned tables opt out via `protected` and use bespoke
handlers.**

## SSoT `structure` engine

`shared/src/ssot/structure.ts` (16 tables in `shared/src/ssot/domain/*`, migration-dependency
order) drives every generic route, validator, and renderer. **A table's shape, permissions, and
scoping come from its descriptor — change those in `domain/*.ts`, don't special-case a table
inside the generic engine.** (Editing the engine itself is normal when you're changing behavior
for all tables.) Read descriptors via the `utils.ts` accessors (`tableOf`, `getPkFields`, …);
derived types are `TableKey` / `TableRecordMap[T]`.

Descriptors (on `TableStructure`): `crud`/`roleRequired` (which ops, which roles); `protected`
(no generic CRUD; may carve a per-op read exception); `ownership`/`grantScope`/`businessScoped`/
`businessJoin`/`roleDiscriminator` (row scoping); `sqlTable`/`sqlReadTable` (write table vs.
secret-free read view); `softDelete`; `schedulable`; `derivable` (server-stamped, never from
body); `referencesUserRole` (FK must point at a user of that role).

**Invariants — do not "fix":**
- `clients`/`professionals` are logical entities, not tables (`sqlTable:'auth.users'` +
  `roleDiscriminator`). User reads go through the `auth.users_directory` secret-free view; writes
  hit `auth.users`.
- `ledger_entries` omits `roleRequired`/`ownership` on purpose — authz is bespoke (a Professional
  may bill their own clients, which a static role list can't express).
- Out-of-scope / unknown / protected / cross-tenant `:id` → **404, never leak existence.** Never
  accept `business_id` from the request body.

## Data-access layer

**All query *execution* goes through `db/core`; hand-written domain SQL lives only in
`backend/src/db/*.ts`.** Add or change a domain query in its module (`db/<domain>.ts`), never
inline in a route. (Exception: the generic CRUD engine still *generates* parameterized SQL text
from the SSoT in `get/post/put/delete.ts` + `crud-policy.ts` + `helpers.ts`, then executes it via
`db/core` — that's the descriptor→SQL compiler, not hand-written queries.) `db/core.ts`: `query<T>`/`queryOne<T>`
(throw `DbError`), `withTransaction` (owns BEGIN/COMMIT/ROLLBACK; rethrows the **original** error
so structured `{status}` loader errors survive), `toRecord` (SSoT coercion, internal only).
`DbError`→HTTP mapping is centralized in `guardRoute` (23505→409, 23503→400, else 500). Result
types live once in `shared/src/ssot/query-types.ts`. **Wire rows are NOT coerced** — pg returns
NUMERIC/BIGINT as strings and the API emits them verbatim; `toRecord` would change the contract.

## Auth / authz

scrypt + per-user salt (dummy-hash for unknown usernames = anti-enumeration). Sessions: random
token in the `aida_session` cookie, `sha256` in DB, 7-day absolute expiry. Middleware order:
`requireAuth` → `requirePasswordReady` → `requireAdmin` → handler; `guardMiddleware` responds 500
on throw **without** calling `next()` (auth-bypass prevention); fail closed everywhere. Two authz
regimes: declarative (generic engine via `crud-policy.ts` — `buildScopeConditions` ANDs
business/owner/grant/discriminator predicates into every statement) and procedural
(`appointment-authz.ts`, run inside the tx so grant-check + write are atomic). Audit:
`createAuditWriter` (pool, best-effort) + `auditInTx` (in-tx, uncatchable); `audit_events` is
append-only.

Roles: **Admin** (business-bounded; null business = super-admin, all tenants) · **Professional**
(own only) · **Receptionist** (needs a `calendar_grant`) · **Client** (self-only).

## Domain workflows (protected tables)

- **Appointments**: states/edges in `TRANSITION_MAP`; enforced app-side + DB trigger; `ends_at`
  trigger-computed. `→ completed` posts an idempotent ledger `charge` for the frozen `price`
  (`no_show` never charges); cancelling a `scheduled` turno needs `now ≥ cancellation_cutoff_hours`
  before start. `price` frozen at booking.
- **Scheduling**: availability computed, never stored (weekly − exceptions − booked); per-block
  `granularity_minutes`, not a fixed grid. **Sobreturno** = staff-only conflict override; the tx
  save takes a per-owner `pg_advisory_xact_lock` and re-runs the same aggregator as the preview.
- **Pricing**: per-client override (`client_professional_services`) > `services.default_price_ars`.
- **Ledger**: append-only; balance = Σ(charge+adj_debit) − Σ(payment+adj_credit), computed on read.
- **Calendar grants**: binary `calendar_grants(professional_user_id, grantee_user_id)`;
  `db/grants.ts` is the only place that knows the shape.

## DB roles & migrations

Two-role least-privilege (`database/bootstrap.sql`, fresh volume only): `aida26_owner` owns objects
+ runs migrations/seeds; `aida26_user` gets per-table grants only (DELETE withheld on soft-delete
tables; INSERT+SELECT only on append-only). Migrations (`migrate.ts`): forward-only, checksummed (a
changed applied file throws over line-ending-normalized bytes), advisory-locked, each in its own tx;
cutover creates tables dependency-ordered with inline FKs. **The runner owns the transaction:**
migration files must not manage their own, so `readMigration` strips top-level transaction control
and the runner aborts if a file ends its transaction anyway (the file and its `schema_migrations`
row commit together or not at all). Seeds are owner-pool, idempotent, not migrations.

**SSoT ↔ SQL drift:** where a value lives in both TS and SQL, prefer deriving over duplicating —
`db/auth.ts` binds `SESSION_DAYS` into the session INSERT (`make_interval`), so the 7-day expiry has
one source. Where the SQL side is an **immutable migration** (roles, appointment states, transition
edges, ledger types, cancellation-cutoff default), it can't derive — `test/schema-ssot-drift.test.ts`
asserts the SSoT constants still match the migration literals so drift fails a test, not production.
