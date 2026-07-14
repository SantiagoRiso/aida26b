# SSoT / SRP Audit — 2026-07-13

Full-codebase scan for Single-Source-of-Truth and Single-Responsibility violations.
Method: six parallel auditors (shared/, backend generic engine, backend routes/services,
db layer + migrations, frontend, cross-package seams), every finding verified at every
cited site. Follow-up to the 2026-07-10 audit (units 1–5, committed); this round covers
the five feature commits landed since (time-off, closures, block editor, grants UI,
layout polish) plus everything the first round's narrower scopes missed.

**Verdict:** the architectural core remains disciplined — the descriptor→SQL engine has
zero table-name special-cases, routes are 100% SQL-free, scoping is single-sourced in
`buildScopeConditions`, and states/roles/ledger types/cutoff flow from shared with drift
tests. The violations concentrate in four bands: (1) the **frontend restates shared
facts wholesale** (labels, wire types, time math, availability shading) and several have
**already drifted**; (2) the **generic write handlers bypass the centralized error
mapping** they're documented to use; (3) the **drift test only reads 2 of 8 migration
files**, so every newer SQL literal is unguarded; (4) **config/env/docs** carry the same
values in 3–4 places each.

Items previously adjudicated as intentional are excluded (AUTH_USERS_PROTECTED
defense-in-depth, clients/professionals logical tables, ledger bespoke authz,
closures' business_id third owner, useCustomDrag, sobreturno lock/re-aggregation,
DNI-vs-username local message, availability computed-not-stored).

Severity: **HIGH** = drift already happened or has a silent/behavioral failure mode ·
**MED** = drift-prone, multi-site edits required · **LOW** = principle/cosmetic.

---

## Part 1 — Cross-cutting: one fact, many homes

These merge findings that surfaced in several areas; all sites listed.

### X1. HH:MM / date format defined ~10× across three packages — MED
The wall-clock format exists as: shared descriptor pattern literals ×4
(`shared/src/ssot/domain/scheduling.ts:115,122,280,287` — `'^([01]\\d|2[0-3]):[0-5]\\d$'`),
backend `HHMM_RE` (`backend/src/time.ts:6`), and a fresh local copy in the newest route
(`backend/src/routes/business-closures.ts:26-27` redefines both `TIME_RE` and `DATE_RE`
byte-identical to `time.ts:6-7`, which every sibling route imports). `DATE_OR_ISO_RE`
plus its parse blocks and error strings are copy-pasted between
`backend/src/routes/appointments.ts:51,656-670` and `backend/src/routes/audit.ts:12,64-78`.

### X2. HH:MM↔minutes and interval-merge math implemented ~15× — MED
Canonical implementations exist in shared but are **private**, so everyone copied them:
- `toMinutes`/`toHHMM`: `shared/src/ssot/domain/scheduling.ts:514-523` (unexported);
  copied at `shared/src/ssot/domain/conflict.ts:42-45` (`toMin`), and in frontend:
  `composables/calendarGrid.ts:16`, `scheduleTemplateGrid.ts:60,65`,
  `useTemplateBlockDrag.ts:52,57`, `useCustomDrag.ts:52`, `useTimegridGeometry.ts:45`,
  `components/schedule/BlockEditorModal.vue:58`, `views/staff/CalendarView.vue:864-872`,
  `views/staff/RequestsView.vue:95-96`, inline in `AppointmentForm.vue:209-211`,
  `SlotPicker.vue:108-112`, `RequestFlow.vue:191-193`; backend seeds:
  `seed-demo.ts:123-129` (`hmToMin`/`minToHm`).
- `mergeIntervals`: `scheduling.ts:525-537` (private) ≡ `conflict.ts:47-56`
  (`mergeMinutes`) ≡ `frontend/src/composables/calendarGrid.ts:33-47`. Also
  `templateBlockPlacement.ts:22-33` re-implements `complementIntervals`
  (`calendarGrid.ts:51-66`) with clamping.
A fix to interval semantics (touching intervals, `24:00` handling) must be found ~15 times.

### X3. Weekday vocabulary in five encodings, SQL side unguarded — MED
`WEEKDAYS` is exported (`shared/src/ssot/domain/scheduling.ts:497`) yet restated:
descriptor options re-list all seven values by hand (`scheduling.ts:102-110`); SQL CHECK
`weekday IN ('sun',...,'sat')` (`database/migrations/20260711_090000_schedule_blocks_services.sql:14`)
is invisible to the drift test (it loads only cutover+phase4 — see D2);
`frontend/src/views/staff/CalendarView.vue:234` and `RequestsView.vue:93` declare
`WEEKDAY_KEYS` locally (both files already import from `@shared/ssot/domain`);
`backend/src/seed-demo.ts:108` declares `WEEKDAY_KEYS` again and reimplements
`weekdayOf` (:110-121) which shared exports.

### X4. Argentina timezone fact encoded 6× with no guard — MED
`BUSINESS_TZ` lives in **backend** (`backend/src/time.ts:4`), not shared; shared
re-encodes the same fact as a fixed offset (`shared/src/validation/validate.ts:12-13`
`ARGENTINA_OFFSET_MS = -3h`); seeds re-declare the string (`seed-foundation.ts:12`,
`seed-demo.ts:13` — neither imports `BUSINESS_TZ`); the migration default
(`20260625_..._cutover.sql:20`) is asserted in `scheduler-schema.test.ts:303` against
*another literal*, not against `BUSINESS_TZ`. Meanwhile the `businesses.timezone` column
is required, editable descriptor data (`business.ts:48-54`) that nothing honors — the
validator says compile-time constant, the descriptor says per-business data; one should own it.

### X5. ARS amount format defined 7× (an extracted constant exists, used once) — MED
`catalog.ts:9-19` extracts `priceColumn` precisely for this, then the same
`'^\\d+(\\.\\d{1,2})?$'` + message is restated at `scheduling.ts:196-202` (block-service
price), `scheduling.ts:417-427` (appointment price), `finance.ts:51-61` (ledger amount),
`backend/src/routes/ledger.ts:33` (`AMOUNT_RE`, comment admits "mirrors amount_ars CHECK"),
`frontend/src/components/ledger/LedgerEntryForm.vue:176` (inline `pattern=`), plus the DB
CHECK. The currency `'ARS'` CHECK (cutover:21) ↔ `business.ts:58` pattern `'^ARS$'` is
also unguarded (frozen by product decision; a one-line drift-test add if D2 is fixed).

### X6. Email regex ×4 — LOW
`shared/src/ssot/domain/people.ts:67-71` (users) and `:160-165` (clients — the same
physical column, so divergence would validate one column two ways);
`backend/src/routes/auth.ts:20`; `backend/src/routes/users.ts:22`.

### X7. `AuthedRequest` declared 15×, `AuditFn` 6× — LOW
`type AuthedRequest = Request & { user?: AuthUser }` in every handler file:
engine `get.ts:33`, `post.ts:27`, `put.ts:30`, `delete.ts:25`, `session.ts:11`,
`app.ts:61` (inline), plus routes `appointments.ts:42`, `audit.ts:14`, `auth.ts:18`,
`business-closures.ts:16`, `grants.ts:17`, `ledger.ts:23`, `scheduling.ts:22`,
`users.ts:20`. `AuditFn` locally re-types the exported `AuditWriter` (`session.ts:31-37`)
in six route files (appointments:44, scheduling:24, business-closures:19, grants:20,
ledger:25, audit:16), silently dropping the `override` param; the "circular import"
comment justifying it is false — `users.ts:8` imports from session with no cycle.

### X8. Pagination policy: three encodings and a live truncation bug — HIGH
Generic engine: default 20 / cap 500 (`backend/src/db/generic.ts:201-204`). Bespoke
routes: default 50 / cap 200, pasted 3× (`appointments.ts:646`, `audit.ts:80`,
`ledger.ts:169`). Frontend: `ClientDetail.vue:117` requests
`listAppointments({ limit: 500 })` → the 200 cap silently truncates a client's history
with no signal; the many `limit: 500` listRows calls match the generic cap by luck
(`GenericTable.vue:87` hardcodes 20). No shared pagination constants exist.

### X9. Response envelope typed independently on both sides of the wire — MED
`backend/src/status_messages.ts:3-23` and `frontend/src/api/client.ts:5-11` each
hand-declare `{success,data,meta}/{success:false,error:{...}}`; shared has no envelope
type. Each side's tests assert its own copy (`backend/test/envelopes.test.ts`,
`frontend/test/api-client.test.ts`), so coordinated drift passes both suites.

### X10. ~30 bespoke API paths free-typed as parallel string literals — MED
Backend `routes/{appointments,scheduling,users,grants,ledger,audit,business-closures,auth}.ts`
↔ frontend `api/{appointments,scheduling,admin-users,grants,ledger,audit,business,closures,profile}.ts`.
No shared path constants; renames are caught only at runtime. (Generic CRUD paths are
clean — both sides derive from `TableKey`.)

### X11. Wire-row vocabulary duplicated: shared query-types vs frontend api/*, with type drift — HIGH
Seven row types re-declared in the frontend, several field-for-field identical:
`api/appointments.ts:5-26` (`Appointment`, declares `id: number` while the wire and the
code's own comments say ids are strings — consequence: `dashboard-current.ts:40` does a
strict number comparison the rest of the app avoids via `String()`), `api/ledger.ts:9-18`,
`api/grants.ts:4-18`, `api/business.ts:4-9`, `api/closures.ts:7-13`, `api/profile.ts:5-11`,
`api/audit.ts:5-16` — vs `shared/src/ssot/query-types.ts:60-156`. Within shared itself,
`BookedAppointment` (`conflict.ts:27-32`, `id: number`) ≡ `BookedAppointmentRow`
(`query-types.ts:129-134`, `id: string`) — same shape, ids already disagree. And
`'scheduled' | 'requested'` literal unions (`conflict.ts:31`, `query-types.ts:133`)
restate `OPEN_APPOINTMENT_STATES`.

### X12. Role and state display labels have 2–3 sources each, both drifted — HIGH
- Appointment states: i18n `status.*` (`frontend/src/i18n/es.ts:87-94`, `en.ts:89-96`)
  vs SSoT `APPOINTMENT_STATES` (`scheduling.ts:57-64`). **Drifted:** es `'Programado'`
  vs `'Agendado'` (scheduled), `'Ausente'` vs `'No asistió'` (no_show); en `'No-show'`
  vs `'No Show'`. Screens split between `t('status.x')` (StatusBadge, detail panels)
  and descriptor `status.values` (GenericTable/Form) — same state renders differently.
- Roles: **three** sources — `ROLE_LABELS` (`people.ts:13-18`), i18n `roles.*`
  (`es.ts:81-86`, drifted: `'Administrador'` vs `'Admin'`), and
  `structure.commonText.*Role` (`structure.ts:114-117`, restates all four despite
  people.ts's comment claiming the label lives "nowhere else").

### X13. Three-and-a-half parallel localization mechanisms; shared commonText/menu are dead — MED
(a) vue-i18n catalogs; (b) hundreds of inline `label({es,en})` literals
(`GenericTable.vue:233,274`, `GenericForm.vue:230-233`, `Pagination.vue:21-40`,
`GenericFilters.vue:88,151`, …); (c) `structure.commonText` (`structure.ts:70-133`)
which already defines `actions/edit/cancel/pageInfo/total/previous/next/addFilter/...`
— **zero frontend imports** (grep-verified), as is `structure.menu` (its
theme/language handlers and `languagechange` event have no listener); (d) a fourth
class of Spanish-only hardcoded strings that bypass everything (F22 below). Language
itself is read from localStorage in three places (`stores/ui.ts:14` — self-declared
"single source", `i18n/index.ts:9`, `structure.ts:8-10`).

### X14. Error→HTTP mapping centralized on paper, bypassed in practice — HIGH
Canonical map: `backend/src/db/errors.ts:25-28` via `guardRoute` (`helpers.ts:10-33`).
Violations: generic `post.ts:111-120` and `put.ts:171-185` re-state 23505→409 inline
with their own 500 fallback; `delete.ts:84-95` catches everything → 500 with **no**
pgCode check. Because all three catch locally, guardRoute's map never runs for generic
CRUD: **a 23503 FK violation on generic POST/PUT/DELETE returns 500 instead of the
centralized 400** — behavioral drift, already live. Additionally `auth.ts` login/logout/
change-password (`:35-78,80-99,105-152`) hand-roll try/catch→500 (a 23505 there returns
500, not 409) while the same file uses guardRoute for `/me/profile`; and
`guardMiddleware` (`helpers.ts:37-53`) duplicates guardRoute's body minus the
structured-error branch, so an `httpError()` thrown from middleware maps to 500.

---

## Part 2 — shared/

### S1. FK descriptors point at a nonexistent `user_id` column — HIGH
Ten descriptor sites declare `foreignKey: { table: 'clients'|'professionals',
valueField: 'user_id' }` (`scheduling.ts:83,167,237,341,350,475`; `catalog.ts:78,88,131`;
`finance.ts:31`) while the entities' pk is `id` (`people.ts:202,245`;
`identityField: 'id'` at `people.ts:23`) and the `auth.users_directory` view has no
`user_id` column (`20260708_120000_client_dni.sql:14-32`). ~15 frontend call sites
hand-patch it (`useForeignKeyOptions({ valueField: 'id' })`, e.g. `ClientDetail.vue:51`).
The descriptors — the SSoT itself — state the identity column two different ways, and
any generic consumer trusting `foreignKey.valueField` breaks.

### S2. structure.ts welds DOM/UI behavior and an i18n catalog onto the table registry — HIGH (SRP)
`structure.ts:3-14` (localization microlibrary reading `globalThis.localStorage`),
`:19-68` (menu config whose handlers call `document.body.setAttribute`,
`localStorage.setItem`, `alert(...)`, `window.dispatchEvent`), `:70-133` (whole-app UI
string catalog) — all wrapped around the actual SSoT (`:16-17`). Browser-only
side-effecting code ships into server context via `utils.ts`/`validate.ts`/`types.ts`
imports; and per X13 the UI half is dead code.

### S3. Appointment state sets: five parallel literal encodings — MED
`TERMINAL_STATES` (:5), `TRANSITION_MAP` (:7-10), `OPEN_APPOINTMENT_STATES` (:29),
`VOID_APPOINTMENT_STATES` (:37), `APPOINTMENT_STATES` (:57-64) in
`shared/src/ssot/domain/scheduling.ts` all spell out the same node partition
(`OPEN ≡ Object.keys(TRANSITION_MAP)`; `TERMINAL ≡ ALL − OPEN`). Adding a state touches
all five with no compiler guarantee of consistency.

### S4. scheduling.ts is three modules in one file (644 lines) — MED (SRP)
State machine + cancellation policy (:5-67), five table descriptors (:69-495), and the
interval/availability algorithm library (:497-643). The algorithm half's privacy
directly caused the X2 copies.

### S5. Receptionist grantScope literal repeated 3× — MED
`{ role:'Receptionist', grantTable:'calendar_grants', grantRowColumn:'professional_user_id',
granteeColumn:'grantee_user_id' }` at `people.ts:267`, `scheduling.ts:139-144`, `:213-218`
— the grant-relationship shape CLAUDE.md says only `db/grants.ts` should know.

### S6. types.ts serves four masters and creates an import cycle — MED (SRP)
`shared/src/types/types.ts` mixes descriptor contract types, `SqlParam` (pg wire
concern, :59), DOM renderer types (`RendererFunc` returning `HTMLElement`, :187-201),
and structure-derived lookups (`TableKey`/`TableRecordMap`) — the last forcing
types.ts→structure.ts→domain/*→types.ts circularity. Also re-exports `Role` (:203),
giving the role type two import paths.

### S7. Assorted duplicated literals in shared — LOW
- `softDelete` policy const declared twice (`people.ts:5-8` ≡ `catalog.ts:4-7`).
- Username/Email labels in `commonText` (:112-113) restate column-descriptor labels
  (`people.ts:58,65`).
- `LocalizedText`/language set: `types.ts:89-90` vs a shadow type in `structure.ts:3-6`
  plus `'es'/'en'` re-encoded in a ternary (:9), a guard (:46), and an options list
  (:62-65) — five sites for one fact.
- CRUD-op union `'create'|'read'|'update'|'delete'` spelled out 4× in types.ts
  (:4-9,18,111-116,171) + a 5th in `utils.ts:70-76`; no `CrudOp` type.
- `referencesUserRole?: 'Professional' | 'Client'` (`types.ts:106`) hand-restates a
  Role subset instead of deriving from `ROLES`.
- Dual-owner `businessJoin` pair byte-identical at `scheduling.ts:132-137` and
  `:315-319`; `businesses` FK triple at `business.ts:24`, `people.ts:54`,
  `scheduling.ts:260`.
- `resolveBooking` pricing/duration workflow logic lives in the catalog descriptor
  file (`catalog.ts:185-218`) by adjacency, not by responsibility (SRP).

---

## Part 3 — backend generic engine

(X14 — the error-mapping bypass — is the headline engine finding.)

### E1. Protected-table exception rule stated twice in crud-policy.ts; runtime ignores the exported accessor — MED
`getCrudPolicy` (:39-49, "some op exception exists") vs `assertCrudAllowed` (:75-87,
"this op excepted") — not even the same predicate; only tests consume the exported one,
so tests assert a rule the runtime doesn't execute. Name also shadows shared
`getCrudPolicy` (`utils.ts:29`).

### E2. Server-derived-field rejection block copy-pasted post↔put — MED
13 identical lines incl. the exact 422 envelope: `post.ts:52-64` ≡ `put.ts:69-81`.

### E3. List-protocol reserved params defined independently 3× — MED
`get.ts:85-100` (`page/sort/dir/limit/filter_`), `db/generic.ts:49,53,164-206`
(re-parses all of them; `key.slice(7)` hardcodes the prefix length),
`frontend/src/api/crud.ts:28` (builds `filter_${field}`). No shared constant; a missed
site silently reroutes list requests down the single-row path.

### E4. Schedule-owner FK columns: derived in one path, hardcoded in three — MED
put.ts derives via `getScheduleOwnerForeignKeys()` (descriptor-driven), but
`crud-policy.ts:131-134,162-197` (`OwnScheduleTarget` + guard logic), `post.ts:86-90`
(body extraction), and `utils.ts:81-83` (`ownerHasResourceColumn` tests `'resource_id' in
columns`) restate `professional_user_id`/`resource_id` as literals. A renamed/added
schedulable owner FK updates one path automatically and silently misses the others.

### E5. "Editable columns" rule enforced by two independent derivations — MED
`shared/validation/validate.ts:105-109` (`editableColumns`, unexported) vs
`put.ts:140-147` (re-derives via direct `structure.tables[...]` access, bypassing the
`tableOf` accessor convention). Validation-accepts and UPDATE-writes sets can drift.

### E6. Two app-assembly paths already drifted — MED
`app.ts:49-77` (createApp: cors, json, static, SPA fallback) vs `server.ts:21-29,91-105`
(repeats all four, plus a dist-path fallback and `trust proxy` only the runtime has).
`mountGenericRoutes` exists precisely to prevent this class of drift; the wrapper
assembly reintroduced it.

### E7. helpers.ts mixes transport error-guards with SSoT accessors — MED (SRP)
`helpers.ts:10-53` (guardRoute/guardMiddleware, Express concerns) vs `:55-104` (eight
pure descriptor accessors). db/generic.ts imports descriptor accessors and transitively
pulls Express response machinery.

### E8. db/generic.ts compiles SQL *and* parses the HTTP query grammar — MED (SRP)
`generic.ts:1` imports `express.Request["query"]`; `:33-236` parses `filter_` prefixes,
`!` negation, `min,max` ranges, sort/dir, page/limit inside the same function that
assembles SQL. Transport grammar and SQL generation can't be tested or reused separately
(root cause of E3).

### E9. session.ts owns four concerns — MED (SRP)
Password policy (:19-21), session loading (:23-29), audit-writer factory incl.
business-id resolution (:43-75), auth middleware (:84-110). The app's audit envelope and
password rule live in a module named "session".

### E10. Engine minor items — LOW
- crud-policy.ts mixes sync declarative policy with async DB-querying guards
  (:70-129 vs :146-198, :208-237) — placement only, mechanism is sanctioned (SRP).
- `physicalTable` no-op fallback conditional restated 5× (`post.ts:50`, `put.ts:67`,
  `delete.ts:48`, `generic.ts:320,338`) though `getSqlTable` already resolved it.
- Fail-closed 401 block pasted in all four handlers + requireAuth (`get.ts:44-46`,
  `post.ts:38-40`, `put.ts:55-57`, `delete.ts:36-38`, `session.ts:88`).
- `business_id` column-name convention as bare literals in `post.ts:104-107`,
  `scope.ts:86,93,101` — no named constant, no per-table override possible.
- Descriptor fields re-asserted via inline casts despite being on `TableStructure`
  (`crud-policy.ts:26,32,99`; `scope.ts:89,114,130,146,152`) — each cast is a second,
  locally-maintained statement of the SSoT type.
- Schedule-guard predicate `isOwnerScheduledTable(t) || professionalOwnerGuardedOn(t,op)`
  repeated verbatim in three handlers (`post.ts:85`, `put.ts:104`, `delete.ts:64`).
- List vs single-row reads built by two divergent compilers (`generic.ts:268-309` renders
  derivable columns + referencedTables JOINs; `buildRowStatement` :330-354 is `SELECT *`)
  — behavior coincides only because no table declares `referencedTables` yet; the first
  one to do so makes list and row responses diverge silently.

---

## Part 4 — backend routes & services

### R1. Booking price/duration resolution pipeline in 3 places — HIGH
Canonical: `services/booking.ts:117-156` (`resolveAndLoadService`). Re-assembled inline
in `routes/scheduling.ts:69-94` (conflict-check) and `routes/appointments.ts:352-371`
(reschedule) — identical `getServiceDefaults → getClientOverridePrice →
getBlockServiceForSlot → resolveBooking` sequence incl. the same 404 message. The
reschedule copy already differs subtly (always passes `sobreturnoDurationMinutes`
without a `callerIsStaff` guard, relying on an earlier 403). Pricing precedence is a
core business rule with three drift-capable assembly sites.

### R2. Booking field-validation block triplicated — MED
`services/booking.ts:101-115` ≡ `routes/scheduling.ts:55-67` ≡
`routes/appointments.ts:339-350`, identical messages incl. the
crosses-midnight guard and 422 envelope.

### R3. Time-off range validation duplicated closures↔preview — MED
`business-closures.ts:34-54` (`parseClosureBody`) ≡ `scheduling.ts:192-210`
(conflict-preview): both-or-neither, HH:MM, end>start, byte-identical messages; the
Admin-only gate mirrored too (:226 vs :71/99/152). Drift here makes the warn-first
preview disagree with the save it exists to mirror.

### R4. `no_business` guard duplicated ~35× with 7 message variants — MED
`if (user.business_id == null) → sendError(400,'no_business',…)` across
`appointments.ts` (10 sites), `scheduling.ts` (4), `business-closures.ts` (4),
`grants.ts` (4), `ledger.ts` (1), `audit.ts` (4), `users.ts` (5),
`appointment-authz.ts` (3). Middleware-shaped check, inconsistently audited, wording
already drifted.

### R5. routes/audit.ts owns two domains — MED (SRP)
Audit-event listing (:31-97) plus the entire writable business-settings surface
(:101-228), with internal copy-paste: admin+404 preamble duplicated GET↔PATCH
(:118-133 vs :146-161), settings fetch/404 tail duplicated (:107-111 vs :135-139),
booking-window cross-field rule inline (:204-208).

### R6. Client request flow re-implements the conflict dry-run inline — MED (SRP)
`appointments.ts:99-128` vs `scheduling.ts:96-110`: same
`loadConflictInputs → addMinutes → evaluateConflicts` dance; hand-builds the
aggregator-owner object (:122) bypassing the existing `toAggregatorOwner`
(`services/scheduling.ts:165`); uses mid-handler dynamic imports of modules the same
file already imports statically (:100, :117).

### R7. Route-layer minor items — LOW
- Cross-tenant 404 predicate + its comment copy-pasted 7× (`grants.ts:60,65,112`;
  `business-closures.ts:113,166`; `services/scheduling.ts:87,99`).
- `users.ts` create-user handler: two full workflows in one 110-line handler with
  duplicated `no_business` checks (:81-83, :123-125) and three near-identical
  `isUniqueViolation` catches (:104-114, :143-155, :293-297) (SRP).
- Seeds duplicate the upsert toolkit (`seed-foundation.ts:31-209` ≈
  `seed-demo.ts:205-333`, already divergent: foundation's `upsertUser` omits `dni`).
- Min-password-length 8 restated in `seed-admin.ts:12` despite `session.ts:19-21`
  declaring itself the single home.
- Grantable-staff rule `('Receptionist','Professional')` as SQL literal
  (`db/grants.ts:111`) and TS check (`routes/grants.ts:68`) — picker/validator pair
  with no shared constant.

---

## Part 5 — db layer & migrations

### D1. `auth.users_directory` view column list has no drift guard — HIGH
The view hand-enumerates 15 columns (`20260702_090000_users_read_view.sql:8-25`), was
already fully re-declared once to append `dni` (`20260708_120000_client_dni.sql:14-32`),
and generic reads for users/clients/professionals are `SELECT *` against it. Adding a
column to a people descriptor without a new view migration makes generic reads silently
return rows **missing that field** — no error, no test (only `sqlReadTable` identity is
asserted, `ssot-domain.test.ts:597-598`).

### D2. Drift test reads only 2 of 8 migration files — HIGH (meta-gap)
`schema-ssot-drift.test.ts:19-20` loads cutover + phase4 only, so every literal in the
six later migrations is structurally out of reach. Concrete uncovered TS↔SQL pairs:
- `audit_events.outcome` CHECK (`cutover.sql:210`) ↔ `AUDIT_OUTCOMES`
  (`business.ts:27-34`) — in a loaded file but simply not asserted; also restated as an
  inline union at `appointment-authz.ts:23`.
- `schedule_blocks.weekday` CHECK ↔ `WEEKDAYS` (see X3).
- `granularity_minutes > 0` + conditional shape rule
  (`20260701_..._granularity.sql:10-17`) ↔ descriptor `minValue: 1`
  (`scheduling.ts:292-299`) — the conditional rule exists only in SQL.
- `min/max_booking_days >= 0` (`20260711_...sql:75-82`) ↔ `minValue: 0`
  (`business.ts:63-78`, `catalog.ts:148-163`).
- timezone default and `'ARS'` CHECK (X4, X5).

### D3. Conflict-eligibility predicate + overlap fragment duplicated within db/scheduling.ts — MED
"Eligible to conflict" (`state IN (...) AND starts_at >= now() AND conflict_ignored = false`)
at `:251-253` and retyped at `:306-308`; the end-exclusive wall-clock overlap fragment
at `:264-265` and `:296-297`. Drift makes the time-off preview count disagree with the
stored conflict flag — the exact pair that must stay in lockstep.

### D4. User-existence/active/role probes scattered across four db modules — MED (SRP+SSoT)
`appointments.ts:17-24` (`clientExistsInBusiness`, **no** `is_active`) vs
`users.ts:26-33` (`activeClientInBusiness`, **with** `is_active`) vs `users.ts:6-14`,
`scheduling.ts:19-26`, `authz.ts:56-63`; plus `resourceExistsInBusiness` living in the
appointments module (:8-15). The `is_active` difference is invisible at call sites:
booking accepts a client the ledger would reject.

### D5. db minor items — LOW
- `UsersWireRow` projection retyped 3× in `db/auth.ts` (:11-12, :54, :73).
- `Queryable` re-declared in `db/grants.ts:14` instead of importing from core.
- Closure/exception projections copy-pasted 5× within `db/scheduling.ts`
  (:144-147 vs :164-167; :186-190, :205-209, :217-221).
- `httpError`/`httpForStructuredError` — generic HTTP machinery — live in
  `db/errors.ts:41-69` (not DB-specific; routes mint 422s via a `db/` import) (SRP).

---

## Part 6 — frontend

(X11, X12, X13 above are frontend-centered; the rest:)

### F1. RequestsView re-implements the staff calendar's availability shading wholesale — HIGH
`RequestsView.vue:87-171` duplicates `CalendarView.vue:234-264` (same 3-fetch
block-loading, first-offering-wins map, `?? 30` fallback, near-identical comments) and
`RequestsView.vue:194-243` duplicates `CalendarView.vue:668-735` (VOID-set filtering,
occupied/requested interval derivation incl. the midnight guard, clip-to-floor,
`fc-slot-*` class emission, trailing-partial tiling) — ~120 lines ×2; any occupancy or
shading change must be mirrored by hand.

### F2. CalendarView.vue is a 1151-line god component — HIGH (SRP)
One script owns: six data loaders, snap-lattice math, slot resolution, raw DOM pointer
handling with manual listener management, custom-drag orchestration, seven computed
background layers, conflict-override state machine, move-confirm dialog, seven prefill
refs, time helpers, and the approve/reschedule API flows. F1's duplication exists
because none of this is extractable.

### F3. Local-date helpers duplicated with a live UTC bug — MED
`todayLocalISO` (`useCurrency.ts:38-42`) is the intended source; copies/variants in
`AppointmentForm.vue:91-99`, `RequestFlow.vue:290-293` (same file imports
`todayLocalISO`!), `SlotPicker.vue:38-43`, `CalendarView.vue:172-176,893-896`,
`useCustomDrag.ts:155-167`, `RequestsView.vue:204-205`. **Live drift:**
`CalendarView.vue:46-48` initializes `visibleRange` with UTC-day
`toISOString().slice(0,10)` — the exact bug `todayLocalISO`'s comment warns about;
`RequestsView.vue:107-111` `dayAfter()` is UTC-unsafe while
`scheduleExceptions.ts:34-38` `nextDay()` is the safe version.

### F4. Currency/date formatting re-implemented beside useCurrency — MED
`AppointmentDetailPanel.vue:126-140` (`fmtPrice` renders `$ 1.234,56` via toLocaleString;
`formatARS` uses Intl currency style — different renderings of the same amount;
`fmtDate` bypasses the UTC-3 day-shift guard useCurrency exists for).

### F5. State→badge-class maps duplicated with visual drift — MED
`StatusBadge.vue:11-26` vs `AppointmentDetailPanel.vue:170-175`: requested is
blue-100/blue-700 in one, info/10-info in the other; completed differs too. Audit
outcome badge map duplicated `DashboardView.vue:562-566` ≡ `AuditView.vue:229-234` (LOW).

### F6. Business rules implemented twice across app halves — MED
- "Professional sees only self" options filter: `useFullCalendar.ts:45-55`
  (`scopeProfessionalOptions`) vs re-implementation in `AppointmentForm.vue:153-158`.
- "Services offered by professional, fallback to all": `AppointmentForm.vue:172-193` vs
  `RequestFlow.vue:130-140` (comment admits "mirrors the staff form").
- Time-off conflict warning copy built verbatim in two callers of the same gate
  (`ExceptionForm.vue:104-107` ≡ `BusinessClosuresSection.vue:69-74`) instead of living
  with `useTimeOffConflictGate`.
- Slot→duration arithmetic in three places (`AppointmentForm.vue:207-212`,
  `RequestFlow.vue:189-194`, `SlotPicker.vue:108-112`) (LOW).

### F7. Role/permission gating restates descriptor roleRequired — MED
`router/access.ts:21-39` `SCREEN_ROLES` — comment says "derived from SSOT
roleRequired.read" but it's a manual table with no drift guard. `ClientDetail.vue:72-74`
and `ProfessionalDetail.vue:48-53` hardcode parallel role lists
(`canCreateLedger/canEditProfile/canDeactivate`) that can diverge from what the server
enforces via descriptors. Permission triplet also re-derived `GenericTable.vue:46-68` vs
`CrudSection.vue:35-38` (LOW).

### F8. Component-level SRP — MED
- `ClientDetail.vue` (470 lines): profile + ledger + appointments + booking + account
  admin; five DetailPanels, two ConfirmDialogs, an override dialog.
- `DashboardView.vue` (601 lines): four role-specific dashboards + conflict triage +
  settle-card feature with its own timers/payments.
- Conflict-override dialog plumbing copy-pasted in four hosts
  (`CalendarView.vue:93-97,1005-1028`, `DashboardView.vue:146-173`,
  `RequestsView.vue:287-322`, `ClientDetail.vue:67-69,148-165`) with drift in
  retry/clear ordering — a `useConflictOverride()` composable is the single home.
- `ResourcesSection.vue:21-69` re-implements `CrudSection.vue:28-82` because CrudSection
  doesn't forward one slot.
- `GenericTable.vue:124-145` re-implements the FK id→label loading
  `useForeignKeyOptions.ts:13-70` already provides (limits 500 vs 200, no shared cache).
- `AppointmentForm.vue` (437 lines) accretes roster fetching, scoping rules,
  service-map fetching, date-stepper math (LOW).

### F9. Frontend minor items — LOW
- Spanish-only strings bypassing i18n and label(): `useConflictVerdict.ts:5-18` (the
  only conflict copy in the app), `ConflictOverrideDialog.vue:93`,
  `CalendarView.vue:476,905`, `AppointmentDetailPanel.vue:217,222,306`,
  `RequestsView.vue:418,422`, `Selector.vue:135,144`, `ToastStack.vue:74`,
  `DetailPanel.vue:87,121`, `GenericFilters.vue:86`, `PlaceholderView.vue:12-13`
  ('Título'/'Descripción' also duplicate SSoT column labels).
- `Turno #${id}` fallback literal ×4 parallel to existing i18n key
  `portal.appointmentFallback` (`useFullCalendar.ts:89`, `DashboardView.vue:200,209`,
  `RequestsView.vue:68`).
- `GenericForm.vue:98` toasts key `genericSuccess` which no i18n catalog defines —
  renders the raw key; toast keys are stringly-typed with no typed list.
- `AuditView.vue:37-44` `ENTITY_TYPES` restates SSoT table titles.
- Template grid visible-day bounds duplicated (`templateBlockPlacement.ts:10-11`
  06:00/23:00 vs `useScheduleTemplate.ts:33-34`).
- Dead component `EventChip.vue` — orphaned duplicate of the inline `eventContent`
  renderer (`useFullCalendar.ts:176-178`) with its own unused STATE_ICONS map.
- Staff detail panel hardcodes Client-cancel rule without the cutoff
  (`AppointmentDetailPanel.vue:59-60`) while the portal uses shared
  `canCancelAppointment` — defensive/dead today, disagrees if ever reached.
- `apiFetch` toasts on every 403 (`client.ts:54,58`) — transport layer making a
  presentation decision call sites can't opt out of (SRP).

---

## Part 7 — config, env, docs

### C1. Compose doesn't pass VERSION/LOG_LEVEL though .env.example documents them — HIGH
`.env.example:7-10` documents both as live; `docker-compose.yml:32-44` passes neither;
`logger.ts:17,28` reads both. Setting them in `.env` silently does nothing in compose runs.

### C2. Test-DB superuser env vars use different names than compose, documented nowhere — HIGH
`backend/test/helpers.ts:22` reads `DB_SUPERUSER`/`DB_SUPERPASSWORD`;
`.env.example:26-27` + `docker-compose.yml:10-11` define `POSTGRES_SUPERUSER`/
`POSTGRES_SUPERPASS`. Same fact, two vocabularies; `npm run test:db` requires
undocumented variables.

### C3. DB roles/passwords/db-name maintained in 4+ places — MED
`bootstrap.sql:10-21`, `docker-compose.yml:37-41`, `.env.example:13-21`,
`DOCKER_SETUP.md:154-171` + `README.md:57,83-84`. bootstrap.sql only re-runs on a fresh
volume, so SQL-side vs env-side password divergence is silent.

### C4. DOCKER_SETUP.md documents infrastructure that doesn't exist — MED
Ten references to `docker-compose.combined.yml` (only `docker-compose.yml` exists);
documents `API_URL` which no code reads (the real var is `API_PROXY_TARGET`,
`docker-compose.yml:80`, `vite.config.ts:24`).

### C5. tsconfig layering broken; `@shared` mapping in 4 files; backend alias dead — MED
`frontend/tsconfig.json` doesn't extend `tsconfig.base.json` — re-declares all seven
base options verbatim plus its own paths; `backend/tsconfig.json` extends but overrides
`paths`, and backend source uses **zero** `@shared` imports (20+ files import
`../../shared/src/...` relatively), so its alias is dead config; `vite.config.ts:10` is
the fourth mapping declaration.

### C6. Config/docs minor items — LOW
- Version in 4 places, already drifted: `.env.example:8` says 1.0.1; all three
  package.json say 1.0.0.
- Seed env vars (`ADMIN_*`, `BUSINESS_NAME`, `seed-admin.ts:8-10,30`) absent from
  `.env.example`; `BUSINESS_NAME` set nowhere.
- Backend container CMD + healthcheck duplicated verbatim Dockerfile ↔
  `docker-compose.yml:59,61` (compose overrides, both maintained).
- Demo credentials triplicated: `seed-demo.ts:14,144-165` ↔ `frontend/e2e/helpers.ts:9-15`
  ↔ `README.md:125-131`.
- `CLAUDE.md:61` says "15 tables"; `structure.tables` has 16.

---

## Verified clean (coverage notes)

- **Engine**: zero table-name special-cases beyond sanctioned `'auth.users'`;
  scoping single-sourced in `buildScopeConditions`; envelope defined once in
  `status_messages.ts`; middleware fail-closed correct.
- **DAL**: zero inline SQL in routes/services (grep-verified); `db.ts` owner/app pools
  share one connection object; `migrate.ts` single-purpose; `db/core.ts` clean.
- **Shared constants that ARE single-sourced and consumed everywhere**: ROLES,
  TRANSITION_MAP/TERMINAL_STATES/APPOINTMENT_STATE_VALUES, LEDGER_ENTRY_TYPES with
  derived debit/credit split, DEFAULT_CANCELLATION_CUTOFF_HOURS,
  `canCancelAppointment`, `computeFreeWindows`/`computeServiceSlots`, SESSION_DAYS via
  make_interval, session cookie name, OPEN/VOID state SQL lists bound from consts.
- **Drift test**: covers roles, states, terminal states, transition edges, ledger
  types, cancellation-cutoff default (its gap is scope — D2).
- **Grants**: calendar_grants shape confined to `db/grants.ts` (backend) and
  `api/grants.ts` (frontend) as designed.
- **Frontend**: generic CRUD paths derived from TableKey both sides; validation
  delegated to shared `validateField`/`validateFullObject`; portal AppointmentsView is
  exemplary shared-rule usage; no hardcoded cutoff or transition-edge lists anywhere.
- **Migrations**: grants match the descriptor/withholding policy; the 20260711
  CREATE+backfill+DROP mix is an atomic forward-only normalization, not hidden
  responsibility; `users_admin_or_business` CHECK is deliberate defense-in-depth.
