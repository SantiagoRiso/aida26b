-- A per-turno acknowledgment that it may overlap time-off (a business closure or the professional's
-- licencia). Set true to keep the turno as-is and stop flagging it in-conflict; the conflict predicate
-- excludes ignored turnos. Reversible. The conflict stays computed — this is the single stored bit that
-- suppresses it. aida26_user's existing table-level UPDATE on appointments already covers the column.
ALTER TABLE appointments
    ADD COLUMN conflict_ignored BOOLEAN NOT NULL DEFAULT false;
