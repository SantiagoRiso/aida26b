BEGIN;

-- The recurrence rule; occurrences are computed (never stored) until touched, then materialize
-- as an ordinary appointments row. No business_id column — business is derived via the owning
-- professional, exactly as appointments already does.
CREATE TABLE appointment_series (
    id                   BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_user_id       BIGINT        NOT NULL REFERENCES auth.users(id),
    professional_user_id BIGINT        NOT NULL REFERENCES auth.users(id),
    service_id           BIGINT        NOT NULL REFERENCES services(id),
    resource_id          BIGINT                 REFERENCES resources(id),
    frequency            VARCHAR(16)   NOT NULL CHECK (frequency IN ('weekly','monthly_dow','monthly_dom')),
    "interval"           INTEGER       NOT NULL CHECK ("interval" > 0),
    weekday              VARCHAR(3)    CHECK (weekday IN ('sun','mon','tue','wed','thu','fri','sat')),
    week_of_month        SMALLINT      CHECK (week_of_month BETWEEN 1 AND 5),
    day_of_month         SMALLINT      CHECK (day_of_month BETWEEN 1 AND 31),
    start_time           TIME          NOT NULL,
    -- Snapshot at creation — every occurrence, virtual or materialized, inherits it.
    duration_minutes     INTEGER       NOT NULL CHECK (duration_minutes > 0),
    -- Frozen at creation — a price change is a deliberate this-and-future/whole-series edit.
    price_ars            NUMERIC(12,2) NOT NULL CHECK (price_ars >= 0),
    start_date            DATE          NOT NULL,
    end_kind              VARCHAR(8)    NOT NULL CHECK (end_kind IN ('count','until','open')),
    end_count             INTEGER       CHECK (end_count > 0),
    end_date              DATE,
    -- Nullable: system-generated series (e.g. migration/import) may have no acting user.
    created_by_user_id    BIGINT        REFERENCES auth.users(id),
    status                VARCHAR(8)    NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT appointment_series_pattern_shape CHECK (
        (frequency = 'weekly'      AND weekday IS NOT NULL AND week_of_month IS NULL     AND day_of_month IS NULL) OR
        (frequency = 'monthly_dow' AND weekday IS NOT NULL AND week_of_month IS NOT NULL AND day_of_month IS NULL) OR
        (frequency = 'monthly_dom' AND weekday IS NULL     AND week_of_month IS NULL     AND day_of_month IS NOT NULL)
    ),
    CONSTRAINT appointment_series_end_shape CHECK (
        (end_kind = 'count' AND end_count IS NOT NULL AND end_date IS NULL) OR
        (end_kind = 'until' AND end_date  IS NOT NULL AND end_count IS NULL) OR
        (end_kind = 'open'  AND end_count IS NULL     AND end_date IS NULL)
    )
);

-- Materialized occurrences link back to the series; a null series_id is a plain one-off appointment.
ALTER TABLE appointments ADD COLUMN series_id BIGINT REFERENCES appointment_series(id);
ALTER TABLE appointments ADD COLUMN occurrence_date DATE;

-- A series can materialize at most one appointment per occurrence date.
CREATE UNIQUE INDEX appointments_series_occurrence_uq
    ON appointments (series_id, occurrence_date) WHERE series_id IS NOT NULL;
CREATE INDEX appointment_series_owner_status_idx
    ON appointment_series (professional_user_id, status);

-- DELETE withheld: series are ended via UPDATE (status='ended'), never hard-deleted.
-- No sequence grant: existing GENERATED ALWAYS AS IDENTITY tables in this repo don't grant
-- SEQUENCE USAGE either — the identity mechanism doesn't require it for INSERT.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE ON appointment_series TO aida26_user';
    END IF;
END
$$;

COMMIT;
