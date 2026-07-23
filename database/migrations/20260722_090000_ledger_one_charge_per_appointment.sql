-- One session charge per appointment, enforced by the schema rather than by a single code path.
-- The completion flow is idempotent via NOT EXISTS, but the manual ledger POST had no such guard, so
-- a charge on an already-charged appointment could post a second one and double the balance. A
-- duplicate now raises unique_violation (23505 -> 409). A charge may also be unlinked (ad-hoc), and
-- NULLs are distinct in a unique index, so stand-alone charges are unconstrained.
CREATE UNIQUE INDEX idx_ledger_entries_one_charge_per_appointment
    ON ledger_entries (appointment_id)
    WHERE entry_type = 'charge';
