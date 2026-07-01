BEGIN;

-- Staff-only memo field; writable in any state, including terminal.
ALTER TABLE appointments
    ADD COLUMN staff_note TEXT;

-- Business-configured window within which clients may cancel a scheduled appointment.
ALTER TABLE businesses
    ADD COLUMN cancellation_cutoff_hours INTEGER NOT NULL DEFAULT 24,
    ADD CONSTRAINT businesses_cancellation_cutoff_hours_check CHECK (cancellation_cutoff_hours >= 0);

-- Replace the unnamed inline entry_type CHECK with a named equivalent that adds the two
-- adjustment subtypes. The inline constraint was auto-named by Postgres; we discover the name
-- at migration time so a future forward-only migration can drop it cleanly by name.
DO $$
DECLARE
    con_name TEXT;
BEGIN
    SELECT conname INTO con_name
    FROM pg_constraint
    WHERE conrelid = 'ledger_entries'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) LIKE '%entry_type%';
    IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE ledger_entries DROP CONSTRAINT %I', con_name);
    END IF;
END
$$;

ALTER TABLE ledger_entries
    ADD CONSTRAINT ledger_entries_entry_type_check
        CHECK (entry_type IN ('charge', 'payment', 'adjustment_debit', 'adjustment_credit'));

-- State-transition backstop. The application layer returns 422 on an invalid transition;
-- this trigger is the defense-in-depth guard for any path that bypasses the application.
CREATE FUNCTION enforce_appointment_state_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Non-state UPDATEs (staff_note, name, etc.) pass through unchanged.
    IF OLD.state = NEW.state THEN
        RETURN NEW;
    END IF;

    -- Terminal states never return to active.
    IF OLD.state IN ('completed', 'canceled', 'no_show', 'rejected') THEN
        RAISE EXCEPTION 'appointment state % is terminal; cannot transition to %',
            OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;

    -- Enforce the legal edge set.
    IF NOT (
        (OLD.state = 'requested' AND NEW.state IN ('scheduled', 'rejected', 'canceled')) OR
        (OLD.state = 'scheduled' AND NEW.state IN ('completed', 'canceled', 'no_show'))
    ) THEN
        RAISE EXCEPTION 'illegal appointment state transition % → %',
            OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_state_transition
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION enforce_appointment_state_transition();

-- Ledger rows are immutable; corrections are new adjustment_debit/credit entries.
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries are immutable; create a new adjustment row to correct'
        USING ERRCODE = 'check_violation';
    RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entries_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Audit rows are append-only; once written they must never change.
CREATE FUNCTION forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_events are append-only'
        USING ERRCODE = 'check_violation';
    RETURN NULL;
END;
$$;

CREATE TRIGGER audit_events_immutable
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- Lift the SELECT-only restriction for the app role. UPDATE/DELETE on ledger and audit
-- remain withheld; the triggers above provide immutability in all environments.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
        EXECUTE 'GRANT INSERT, UPDATE ON appointments   TO aida26_user';
        EXECUTE 'GRANT INSERT         ON ledger_entries TO aida26_user';
        EXECUTE 'GRANT INSERT         ON audit_events   TO aida26_user';
        -- calendar_grants stays SELECT-only; grant management is through explicit endpoints.
    END IF;
END
$$;

COMMIT;
