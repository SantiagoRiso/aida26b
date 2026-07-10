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

# Backend architecture reference

Multi-tenant (per `business_id`) appointment/agenda system. Express 4 + `pg` (`Pool`) +
Postgres. Argentina-only: single timezone `America/Argentina/Buenos_Aires`, ARS-only.
The load-bearing idea: **almost everything is generated at runtime from one SSoT object;
a set of workflow-owned tables opt out and are driven by bespoke handlers.**

## The SSoT `structure` engine (the heart)

`structure` (`shared/src/ssot/structure.ts`) is the single source of truth, imported by
both backend and frontend. Its `tables` map (15 tables, spread from
`shared/src/ssot/domain/*` in **migration-dependency order**: business → people →
catalog → scheduling → finance) drives every generic route, validator, and form/table
renderer. **To change a table's shape, permissions, SQL routing, or column typing, edit
its descriptor in `domain/*.ts` — never patch the generic route/renderer code, which is
descriptor-driven by design.** Adding a table = add it to a domain module; it auto-joins
`TableKey`/`TableRecordMap`.

Descriptor vocabulary (on `TableStructure`, `shared/src/types/types.ts`):

| Descriptor | Declares / drives |
|---|---|
| `crud` | which of create/read/update/delete the generic engine exposes (explicit; withheld op = domain rule, e.g. `professional_services.update:false` — "change = remove + add") |
| `protected` | workflow-owned; excluded from generic CRUD (may carve a narrow per-op `crud` read exception, as `users` does) |
| `roleRequired` | per-op allow-list of roles gating generic CRUD |
| `ownership` | column holding the row's owner `user_id` + role + `ops` it self-scopes (Client scopes every op; Professional only `update`/`delete` — reads stay open so Clients can browse to book) |
| `grantScope` | limits a role's rows to those named by a grant row (Receptionist ↔ `calendar_grants`) |
| `businessScoped` / `businessJoin` | direct `business_id` column vs. join path(s) to derive it (dual `paths` = dual-owner tables: schedules/exceptions) |
| `roleDiscriminator` | ANDs `column = value` into every op so several logical entities can share one physical table |
| `sqlTable` / `sqlReadTable` | physical write target vs. secret-free **read** view (see invariants) |
| `softDelete` | turns generic delete into an archive (set `deleted_at`) |
| `schedulable` | availability is **computed, never stored** (weekly − exceptions − booked) |
| `derivable` column | server-stamped in SQL (e.g. `id`, `business_id`), never accepted from the request body |
| `referencesUserRole` | asserts an FK points at a user of a given role (replaces a removed composite-FK constraint; enforced by trigger too) |

Derived types (`types.ts:187-195`): `InferType` maps a table's columns to a TS record;
`TableKey` = union of table names; `TableRecordMap[T]` = the SSoT per-table row type.
Read descriptors through the sanctioned accessors in `shared/src/utils/utils.ts`
(`tableOf`, `getPkFields`, `isProtected`, `getSoftDeletePolicy`, …) — the table literals
use `satisfies TableStructure`, which hides optional fields behind the narrow literal.

**Non-obvious invariants (do not "fix" these):**
- `clients`/`professionals` are **logical entities, not tables** — `sqlTable:'auth.users'`
  + `roleDiscriminator` redirect all their SQL to `auth.users`.
- Reads of user tables go through `auth.users_directory` (a **secret-free view**) via
  `sqlReadTable`, so a generic `SELECT *` never projects `password_hash`/`password_salt`/
  `username`; writes still hit `auth.users`.
- `ledger_entries` deliberately omits `roleRequired`/`ownership` — its authz is bespoke
  (`assertLedgerWriteAllowed`) because a Professional may bill their own clients, which a
  static role list can't express. Adding inert metadata would misstate who is permitted.
- `referencedTables` is a declared capability currently **unused** by any table (the
  generic JOIN branch in `get.ts` is dormant).

## Generic CRUD engine

Four table-agnostic handlers serve every non-protected table: `GET/POST/PUT/DELETE
/api/:tableName[/:id]` (`backend/src/routes/{get,post,put,delete}.ts`, wired in
`app.ts`, each wrapped in `guardRoute`). Per request: fail-closed auth (no `req.user` →
401) → `assertCrudAllowed` (`crud-policy.ts`) → resolve physical table → validate → SQL
generation from `structure` → `tryQuery` → `sendData/sendList/sendError`.

- **SQL is generated, identifiers come only from the SSoT**; request-supplied names are
  lookup keys into SSoT maps, values always `$N` bind params. Filtering honors only
  `filterable` columns, sorting only `sortable`∪PK, pagination clamped. `softDelete`
  makes delete an archiving UPDATE.
- **Authorization/scoping is centralized** in `crud-policy.ts`: `roleRequired` → 403;
  `assertCrudAllowed` builds business/ownership/grant/discriminator WHERE fragments,
  renumbered/assembled in one place (`buildScopeConditions`, order discriminator →
  business → owner → grant). **Out-of-scope rows are made invisible** (ANDed predicates),
  so a bad single-row op degrades to `rowCount 0` → **404, never leaking existence**.
  Async guards that need DB lookups (`assertOwnScheduleAllowed`,
  `assertRoleCheckedReferences`) run in the handler.
- Reachable iff `crud` declared **and** not `protected` (unknown *and* protected → 404).
- **Known typing hole:** `tryQuery` returns `Response.data: any` (`types.ts:5`), so rows
  are read untyped (`.data.rows[0]`). This is the seam the data-access-layer refactor
  closes — see `docs/superpowers/specs/2026-07-09-backend-data-access-layer-design.md`.

## Auth / session / authorization

- **Passwords**: `crypto.scrypt` + per-user 16-byte salt; verify via `timingSafeEqual`.
  Login runs scrypt against a dummy hash for unknown usernames (anti-enumeration).
- **Sessions**: random token returned only in the `aida_session` cookie
  (`HttpOnly; SameSite=Lax; Secure` in prod); DB stores `sha256(token)`. 7-day absolute
  expiry, no sliding renewal. `loadSession` validates token + `expires_at > now()` +
  `is_active` in one JOIN, so a deactivated/expired user resolves to `null`. Password
  change deletes all other sessions. `publicUser` (`auth.ts:95`) is the single row→identity
  sanitizer (BIGINT→Number; `business_id null` = super-admin).
- **Middleware chain** (prepended per-route, not global): `requireAuth` →
  `requirePasswordReady` (403 until forced change done) → `requireAdmin` (admin routes) →
  handler. `guardRoute` wraps terminal handlers; `guardMiddleware` wraps guards and on
  throw responds 500 **without calling `next()`** — a failing guard must terminate, never
  fall through to the protected handler (auth-bypass prevention). Fail closed everywhere.
- **Two authz regimes:** (A) declarative generic engine (above); (B) procedural guards
  for workflow tables (`appointment-authz.ts`) that need DB lookups, called inside the
  handler's transaction so the grant check and the write are atomic (no
  revoke-between-check-and-write window on financial/lifecycle routes).
- **Audit**: two writers — `createAuditWriter` (pool, best-effort, never breaks a request)
  and `auditInTx` (on the caller's tx connection, **uncatchable** so a transition can't
  commit without its trail). `audit_events` is append-only (trigger + INSERT/SELECT-only
  grants).

Roles (DB `CHECK`; `Admin | Professional | Receptionist | Client`): **Admin** =
business-bounded superuser (null business = super-admin, sees all tenants); **Professional**
= own appointments/schedules/clients only; **Receptionist** = no inherent access, needs a
`calendar_grant` per professional; **Client** = self-only, barred from all staff actions.

## Domain workflows (the `protected` tables)

- **Appointment lifecycle**: states `requested/scheduled/completed/canceled/no_show/
  rejected`; legal edges in `TRANSITION_MAP` (`domain/scheduling.ts`). Enforced three ways:
  app (`assertValidTransition`), DB trigger backstop, and `ends_at` recomputed by trigger
  (never client-supplied). Each mutation wraps write + audit in one tx. **Side effects:**
  `→ completed` posts an idempotent `charge` to the ledger for the frozen `price`
  (`no_show` never charges); cancellation of a `scheduled` turno requires `now` ≥
  `cancellation_cutoff_hours` before start (`canCancelAppointment`, shared with the portal
  button). `price` is captured at booking and frozen thereafter.
- **Scheduling/availability**: computed, never stored = weekly pattern − dated exceptions
  − booked. **Per-block granularity** (each weekly block carries its own
  `granularity_minutes`), *not* a fixed 15-min grid. Conflict checks return a
  language-neutral `ConflictVerdict` (frontend localizes). **Sobreturno**: staff-only
  override (`can_override = callerIsStaff`); a warn-first booking rolls back and returns
  the verdict unless `override:true`, then writes `override_conflict=true` +
  `override_actor_id`. The transactional save takes a `pg_advisory_xact_lock` per owner
  and re-runs the *same* loader+aggregator as the preview (no check/save drift).
- **Pricing**: per-client override (`client_professional_services`) wins over
  `services.default_price_ars`; resolved once and frozen onto the appointment.
- **Ledger**: append-only current account (DB trigger + INSERT/SELECT-only grants);
  types `charge/payment/adjustment_debit/adjustment_credit`; balance =
  `Σ(charge+adj_debit) − Σ(payment+adj_credit)`, computed on read.
- **Calendar grants**: `calendar_grants(professional_user_id, grantee_user_id)` — binary,
  presence = access, no permission columns. `grant-queries.ts` is the **only** place that
  knows the table's shape (the pattern the DAL refactor generalizes).

## Data model & DB roles

- **Two-role least-privilege model** (`database/bootstrap.sql`, runs once as superuser on
  a fresh volume): `aida26_owner` owns the DB + all objects and runs migrations/seeds;
  `aida26_user` (app runtime) gets only `CONNECT`+`USAGE` at bootstrap, then explicit
  per-table grants in migrations. **DELETE withheld** on soft-deleted tables;
  **INSERT+SELECT only** on append-only tables (`ledger_entries`, `audit_events`), backed
  by immutability triggers so the guarantee holds outside the app. Owner and app
  connections share one host/port/database config (`db.ts`); only credentials differ
  (`createOwnerPool` throws if owner env is unset — no silent fallback).
- **Migrations** (`migrate.ts`): forward-only, advisory-locked (`7910`), recorded in
  `schema_migrations` with a **checksum** — a changed applied file throws ("write a new
  migration"). Files `YYYYMMDD_HHMMSS_*.sql`, lexically ordered, each in its own tx. The
  cutover migration creates tables dependency-ordered with **inline FKs**; later files are
  ALTERs. DB backstops app authz: `users_admin_or_business` CHECK, `business_id` FK
  `ON DELETE RESTRICT`, `enforce_referenced_user_role` trigger.
- **Seeds** (owner pool, idempotent, **not** migrations): `seed-admin` (runs every backend
  start), `seed:foundation` (minimal dev fixture), `seed:demo` (dense BsAs clinic dataset,
  anchored to July 2026). See README for the Docker run model.

## Drift risks / gotchas

- `SESSION_DAYS=7` (`auth.ts`) and the SQL `interval '7 days'` (`routes/auth.ts`) are
  duplicated constants — keep in sync.
- Never accept `business_id` from a request body — it is session-derived and server-stamped.
- Cross-tenant `:id` returns **404** (hide existence), never 403 — preserve this.
