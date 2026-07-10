import type { TableRecordMap, ColumnValue } from '../types/types';

// Result shapes that are not full-table records (projections and joins). One home for the
// vocabulary; per-domain db modules import their return types from here. Rows stay snake_case
// to match the wire contract the routes already emit.

// calendar_grants as returned by the grant endpoints: the SSoT record plus the DB-managed
// created_at timestamp, which is not part of the generic column set.
export type CalendarGrantRow = TableRecordMap['calendar_grants'] & { created_at: string };

export type ActiveProfessionalRow = { user_id: string; business_id: string | null };
export type ActiveUserRow = { id: string; role: string; business_id: string | null };

// A grant joined to its owning professional's business, for tenant-scoped revoke.
export type GrantBusinessRow = {
  id: string;
  professional_user_id: string;
  grantee_user_id: string;
  business_id: string | null;
};

// appointments wire row as node-pg returns it: BIGINT and NUMERIC arrive as strings,
// TIMESTAMPTZ as Date. Emitted verbatim to the client, so it is NOT run through toRecord
// (coercing price to a number would change the wire contract).
export type AppointmentRow = {
  id: string;
  client_user_id: string;
  professional_user_id: string;
  resource_id: string | null;
  service_id: string;
  starts_at: Date;
  duration_minutes: number;
  ends_at: Date;
  state: string;
  name: string | null;
  description: string | null;
  price: string;
  override_conflict: boolean;
  override_actor_id: string | null;
  staff_note: string | null;
  created_at: Date;
  updated_at: Date;
};

// Wall-clock date/start of an appointment, derived in SQL at the business timezone.
export type AppointmentWallClock = { date: string; start: string };

// ledger_entries wire row (append-only). NUMERIC amount_ars and BIGINT ids arrive as strings;
// emitted verbatim to the client.
export type LedgerEntryRow = {
  id: string;
  client_user_id: string;
  appointment_id: string | null;
  entry_type: string;
  amount_ars: string;
  description: string | null;
  actor_user_id: string | null;
  created_at: Date;
};

// A generic-CRUD row: the engine is table-agnostic, so values are bounded to ColumnValue
// rather than a per-table shape. Forwarded verbatim to the client (never coerced).
export type GenericRow = Record<string, ColumnValue>;

// Owner-identity lookups for the scheduling loader (business scoping is applied by the caller).
export type ProfessionalOwnerRow = { display_name: string; business_id: string | null };
export type ResourceOwnerRow = { name: string; business_id: string | null };

// A schedule_exceptions row projected to wall-clock HH:MM for the availability aggregator.
export type ScheduleExceptionRow = {
  is_unavailable: boolean;
  start_time: string | null;
  end_time: string | null;
  granularity_minutes: number | null;
};

// An open appointment projected to wall-clock HH:MM for conflict evaluation.
export type BookedAppointmentRow = {
  id: string;
  start: string;
  end: string;
  state: 'scheduled' | 'requested';
};

// businesses config surface exposed by the settings endpoints.
export type BusinessSettingsRow = { id: string; cancellation_cutoff_hours: number };

// audit_events projected for the admin audit view. details is the JSON blob written by the
// audit writer (a Record<string, ColumnValue>), read back verbatim.
export type AuditEventRow = {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: string;
  ip: string | null;
  details: Record<string, ColumnValue> | null;
  created_at: Date;
};
