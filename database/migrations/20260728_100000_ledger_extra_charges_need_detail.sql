-- A turno may now carry more than one charge (e.g. a materials fee alongside the session charge),
-- provided every charge past the automatic one explains itself. Narrow the index rather than
-- dropping it: at most one undescribed (automatic) charge per appointment stays enforced, since
-- that double-post is exactly what the original guarded against. Any number of described charges
-- are schema-unconstrained (the route requires the description; this index only backs the
-- automatic-charge invariant).
DROP INDEX idx_ledger_entries_one_charge_per_appointment;

CREATE UNIQUE INDEX idx_ledger_entries_one_auto_charge_per_appointment
    ON ledger_entries (appointment_id)
    WHERE entry_type = 'charge' AND description IS NULL;
