import type { ColumnValue } from '../types/types';
import type { BookedAppointment } from './domain/conflict';
import type { EndKind, Frequency, SeriesStatus } from './domain/recurrence';
import type { Weekday } from './domain/availability';

// Result shapes that are not full-table records (projections and joins). One home for the
// vocabulary; per-domain db modules import their return types from here. Rows stay snake_case
// to match the wire contract the routes already emit.

// JSON wire view of a DB-result row: res.json() turns Date into an ISO string; everything else
// (BIGINT/NUMERIC strings, numbers, booleans, null) crosses unchanged. Frontend api modules
// consume Wire<Row> so the row vocabulary lives only here.
export type Wire<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

// calendar_grants as returned by the grant endpoints, enriched with the grantee's and
// professional's names so the UI can render a grant list without a second lookup.
export interface CalendarGrantRow {
  id: string;
  professional_user_id: string;
  grantee_user_id: string;
  created_at: string;
  grantee_username: string;
  grantee_role: string;
  professional_name: string;
}

// Staff eligible to receive a calendar grant (Receptionist/Professional), for the
// grant-picker UI. Sourced from the secret-free auth.users_directory view.
export interface GrantableStaffRow {
  id: string;
  username: string;
  role: string;
  display_name: string | null;
}

// The raw row RETURNING gives immediately after INSERT, before the name-enrichment join
// listCalendarGrants applies on read.
export type CalendarGrantCreatedRow = {
  id: string;
  professional_user_id: string;
  grantee_user_id: string;
  created_at: string;
};

// The user-probe row (findUser): existence checks null-test it; grants read role/business_id.
export type UserProbeRow = { id: string; role: string; business_id: string | null };

// The caller's own profile fields (self-service read/write), never another user's.
// email is null only for a client recorded without one; staff accounts always carry an address.
export interface SelfProfileRow {
  id: string;
  display_name: string;
  bio: string | null;
  email: string | null;
  phone: string | null;
}

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
  // Staff acknowledged this turno may overlap time-off — keep it and stop flagging it (suppresses
  // in_conflict). The one stored bit; reversible.
  conflict_ignored: boolean;
  // Present only on list reads: an open, future turno overlapping active time-off (a business
  // closure or its professional's exception) or a conflicting virtual occurrence of an active
  // recurrence rule, not yet ignored. Computed per read, never stored.
  in_conflict?: boolean;
  // Links a materialized occurrence back to its recurrence rule. Null for one-off appointments.
  series_id: string | null;
  occurrence_date: string | null;
  // Always absent/false on a real row — distinguishes it from a VirtualOccurrence when both share
  // a ListAppointment[] response.
  is_virtual?: boolean;
  // Referenced names, joined in from services / auth.users_directory so the client never has to
  // resolve a title from a separate FK-options fetch (which races the first render). Present on
  // every list/detail GET (loadAppointment/listAppointments); absent on a mutation response, which
  // returns the bare RETURNING * row — same "present only on some reads" contract as in_conflict.
  service_name?: string;
  professional_name?: string;
  client_name?: string;
};

// Client-role responses deliberately omit staff-only fields; staff responses include them.
export type AppointmentResponse = Omit<Wire<AppointmentRow>, 'staff_note' | 'override_actor_id'>
  & Partial<Pick<Wire<AppointmentRow>, 'staff_note' | 'override_actor_id'>>;

// An un-materialized recurring occurrence, computed on read from an active appointment_series and
// never stored — the list endpoint unions these with real rows for the same window. There is no
// appointments row yet, so identity is (series_id, occurrence_date), not an id.
export type VirtualOccurrence = {
  id: null;
  series_id: string;
  occurrence_date: string;
  client_user_id: string;
  professional_user_id: string;
  service_id: string;
  resource_id: string | null;
  starts_at: string;
  duration_minutes: number;
  price: string;
  state: 'scheduled';
  name: null;
  description: null;
  is_virtual: true;
  in_conflict: boolean;
  // Always present: expanded from an active appointment_series, itself joined to services/
  // auth.users_directory at the source (see AppointmentSeriesRowWithNames) — unlike a real
  // AppointmentRow, a virtual occurrence is never built from a bare mutation RETURNING row.
  service_name: string;
  professional_name: string;
  client_name: string;
};

// appointment_series rows enriched with the referenced service/professional/client display names,
// for expanding into VirtualOccurrence — a plain `AppointmentSeriesRow` (RETURNING * from an insert/
// update) never carries these, so this is a distinct type rather than added fields on the base row.
export type AppointmentSeriesRowWithNames = AppointmentSeriesRow & {
  service_name: string;
  professional_name: string;
  client_name: string;
};

// The appointments list response shape: real rows (some carrying series_id when materialized)
// unioned with virtual occurrences of the same active series within the requested window.
export type ListAppointment = AppointmentRow | VirtualOccurrence;

// appointment_series wire row: the recurrence rule, never the occurrences themselves (those are
// computed, then materialize as ordinary `appointments` rows). BIGINT/NUMERIC arrive as strings;
// INTEGER/SMALLINT arrive as numbers — same split AppointmentRow already follows for duration_minutes
// vs. price. Emitted verbatim, never coerced.
export type AppointmentSeriesRow = {
  id: string;
  client_user_id: string;
  professional_user_id: string;
  service_id: string;
  resource_id: string | null;
  frequency: Frequency;
  interval: number;
  weekday: Weekday | null;
  week_of_month: number | null;
  day_of_month: number | null;
  start_time: string;
  duration_minutes: number;
  price_ars: string;
  start_date: string;
  end_kind: EndKind;
  end_count: number | null;
  end_date: string | null;
  created_by_user_id: string | null;
  status: SeriesStatus;
  created_at: Date;
  updated_at: Date;
};

export type AppointmentSeriesResponse = Wire<AppointmentSeriesRow>;

export type AppointmentSeriesInsert = Pick<AppointmentSeriesRow,
  | 'client_user_id'
  | 'professional_user_id'
  | 'service_id'
  | 'resource_id'
  | 'frequency'
  | 'interval'
  | 'weekday'
  | 'week_of_month'
  | 'day_of_month'
  | 'start_time'
  | 'duration_minutes'
  | 'price_ars'
  | 'start_date'
  | 'end_kind'
  | 'end_count'
  | 'end_date'
> & { created_by_user_id: string };

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

// A business-wide closure (schedule_exceptions row owned by the business) as the closures endpoint
// emits it: dates/times projected to strings for the Negocio management UI.
export interface BusinessClosureRow {
  id: string;
  exception_date: string;      // 'YYYY-MM-DD'
  start_time: string | null;   // 'HH:MM' or null (full-day closure)
  end_time: string | null;
  reason: string | null;
}

// An open appointment projected to wall-clock HH:MM for conflict evaluation. Same shape as
// the aggregator's BookedAppointment except the id: the wire carries the BIGINT as a string;
// the loader converts to number at the domain boundary.
export type BookedAppointmentRow = Omit<BookedAppointment, 'id'> & { id: string };

// businesses config surface exposed by the settings endpoints.
export type BusinessSettingsRow = {
  id: string;
  cancellation_cutoff_hours: number;
  min_booking_days: number;
  max_booking_days: number | null;
};

// audit_events projected for the admin audit view. details is the JSON blob written by the
// audit writer, read back verbatim. A value may be a list as well as a scalar — ending a series
// records the ids it cancelled.
//
// business_id is projected only for a super-admin (cross-tenant) read, so it can tell which tenant
// each row belongs to; a tenant Admin's rows are all their own business and the field is omitted,
// leaving their payload unchanged. Null marks a tenantless system event (a login attempt on a
// username nobody holds).
export type AuditEventRow = {
  id: string;
  business_id?: string | null;
  actor_user_id: string | null;
  // Null when the event has no actor, and when the actor row is gone — audit rows outlive the
  // users they name.
  actor_username: string | null;
  // What the event was about, in words: the account for a user event, whose turno and when for an
  // appointment. Null for entity types with no natural name, which keep showing their id.
  entity_label: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: string;
  ip: string | null;
  details: Record<string, ColumnValue | ColumnValue[]> | null;
  created_at: Date;
};
