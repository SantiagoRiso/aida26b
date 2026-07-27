// Sortable columns for the lists the generic engine doesn't own. A descriptor-driven list derives
// its sortable set from the SSoT column definitions; a bespoke list has no descriptor, so it
// declares the set here — once. The backend maps each name to a SQL expression (exhaustively, so a
// missing or stray name is a type error) and the views gate the URL and the header controls against
// the same names, which is what keeps the two ends from disagreeing about what is sortable.

// The actor column sorts by username because that is what it shows; ordering by the underlying id
// would scatter the visible names.
export const AUDIT_SORT_FIELDS = ['created_at', 'event_type', 'entity_type', 'actor_username', 'outcome'] as const;
export type AuditSortField = (typeof AUDIT_SORT_FIELDS)[number];

export const LEDGER_SORT_FIELDS = ['created_at', 'entry_type', 'amount_ars'] as const;
export type LedgerSortField = (typeof LEDGER_SORT_FIELDS)[number];

// Limited to values a not-yet-materialized recurring occurrence also carries: a date-range turno
// list unions those virtuals with the stored rows and re-sorts the union in memory, and it can only
// reproduce an order over fields both shapes have.
export const APPOINTMENT_SORT_FIELDS = ['starts_at', 'price', 'duration_minutes', 'state'] as const;
export type AppointmentSortField = (typeof APPOINTMENT_SORT_FIELDS)[number];
