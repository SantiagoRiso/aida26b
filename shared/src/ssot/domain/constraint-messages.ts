// Postgres constraint/index names live in immutable migrations (see database/migrations) and
// cannot be derived from TS. This module is the single place that names them, so a name is typed
// once and reused by the backend's error mapping (db/errors.ts), the db-level drift guard
// (test/constraint-detail-keys.db.test.ts), and this file's own inline rationale for what stays
// unmapped. Keys resolve against the frontend's `apiError.<key>` i18n namespace.

// Safe to reveal precisely on ANY surface that can trip them: every one of these constraints sits
// on a staff-only or self-consistent write (never reachable by an unauthenticated caller or by a
// Client acting on another tenant's data), and none of them reveal a *person's* existence the way
// a username/email/DNI collision would: they only say "this pairing/value already exists",
// which the caller already has visibility into via its own authorized reads.
export const CONSTRAINT_DETAIL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  calendar_grants_unique: 'grantAlreadyExists',
  professional_services_unique: 'serviceAlreadyOffered',
  client_professional_services_unique: 'clientPriceOverrideExists',
  schedule_block_services_unique: 'blockServiceAlreadyOffered',
  // Both express the same "end must be after start" rule; one detail key covers both.
  schedule_blocks_time_order: 'endAfterStart',
  schedule_exceptions_time_range_check: 'endAfterStart',
  schedule_exceptions_granularity_check: 'exceptionGranularityRequired',
  // Both express "exactly one owner" (schedule_exceptions has a third, business-wide owner, but
  // it is server-stamped/editable:false, so a request body can only ever supply the same two).
  schedule_blocks_one_owner: 'scheduleOwnerExactlyOne',
  schedule_exceptions_one_owner: 'scheduleOwnerExactlyOne',
  // Only the automatic (undescribed) session charge is unique per appointment; an extra charge is
  // legal but must carry a description (enforced by the route, in-transaction, before this index
  // is ever reached in normal use — see routes/ledger.ts).
  idx_ledger_entries_one_auto_charge_per_appointment: 'autoChargeAlreadyPosted',
});

// auth.users unique constraints are deliberately EXCLUDED from CONSTRAINT_DETAIL_KEYS above.
// username/email are unique across the whole system (not per-tenant), and email is also the
// self-service profile's own write target (PATCH /api/auth/me/profile, reachable by every
// authenticated role). Mapping them in the shared, route-agnostic httpForDbError would hand any
// logged-in Client a cross-tenant existence oracle: "that email is already registered" leaks a
// real address's presence anywhere in the system, not just their own business. DNI is per-business
// (uq_users_business_dni), but is also reachable through a Client's own self-service profile edit
// (clients.dni is generically editable): same shape of risk, one tenant instead of every tenant.
//
// This suppresses the WORDING only: a self-service profile edit that collides still answers 409
// instead of 200, which is itself an oracle regardless of message text. Closing that gap needs the
// route to answer alike either way, not a message change.
//
// These three stay precise ONLY on the admin/staff user-creation surfaces (POST /api/admin/users,
// POST /api/admin/users/:id/enable-login, restricted to Admin, or a Professional/Receptionist
// registering a Client, never an anonymous or Client caller), applied explicitly in
// routes/users.ts rather than through the global constraint map. Every other path that can trip
// them (self-service profile edit, generic PUT on clients.dni) intentionally keeps today's
// generic conflict message.
export const USER_IDENTITY_CONSTRAINT_DETAIL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  users_username_key: 'usernameTaken',
  users_email_unique: 'emailTaken',
  uq_users_business_dni: 'dniTaken',
});

// Every other UNIQUE/CHECK constraint the live schema declares (see
// test/constraint-detail-keys.db.test.ts, which asserts this list against pg_constraint/pg_indexes
// so a migration that adds a new one without a decision here fails a test). Left generic for one
// of three reasons documented at each group below, never because nobody looked.
export const INTENTIONALLY_GENERIC_CONSTRAINTS: readonly string[] = [
  // --- App-level validation runs first and already produces a precise fieldError/detail before
  // the request can reach the database; the DB CHECK is a defense-in-depth backstop that normal
  // use can't trigger. (Column-level SSoT validators for generic-CRUD tables; bespoke per-route
  // checks for business-settings, ledger, and appointment-series.)
  'services_default_duration_minutes_check',
  'services_default_price_ars_check',
  'client_professional_services_price_ars_check',
  'schedule_block_services_duration_minutes_check',
  'schedule_block_services_price_ars_check',
  'schedule_blocks_weekday_check',
  'professional_services_min_booking_days_check',
  'professional_services_max_booking_days_check',
  'businesses_min_booking_days_check',
  'businesses_max_booking_days_check',
  'businesses_cancellation_cutoff_hours_check',
  'ledger_entries_entry_type_check',
  'ledger_entries_amount_ars_check',
  'appointments_duration_minutes_check',
  'appointments_price_check',
  'appointments_state_check',
  'appointment_series_frequency_check',
  'appointment_series_interval_check',
  'appointment_series_weekday_check',
  'appointment_series_week_of_month_check',
  'appointment_series_day_of_month_check',
  'appointment_series_duration_minutes_check',
  'appointment_series_price_ars_check',
  'appointment_series_end_kind_check',
  'appointment_series_end_count_check',
  'appointment_series_status_check',
  'appointment_series_pattern_shape',
  'appointment_series_end_shape',
  // --- Internal invariants never driven by request-body input under normal use: server-derived
  // columns (role, business_id, soft-delete bookkeeping), or a fixed system constant.
  'users_role_check',
  'users_admin_or_business',
  'users_client_or_email',
  'users_login_requires_email',
  'users_soft_delete_consistency',
  'resources_soft_delete_consistency',
  'services_soft_delete_consistency',
  'businesses_currency_code_check',
  'audit_events_outcome_check',
  'sessions_token_hash_key',
  // --- Structurally handled elsewhere: caught and retried, never surfaced as a user-facing error.
  // services/series-materialize.ts treats a 23505 here as "a concurrent call already materialized
  // this occurrence" and returns the existing row instead of an error.
  'appointments_series_occurrence_uq',
];
