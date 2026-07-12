-- Normalize scheduling: replace the opaque schedules.weekly JSONB with real block rows, each
-- professional block offering a set of services with optional per-block duration/price overrides.
-- Also add the per-business + per-service booking-window fields. Backfills existing schedules, then
-- drops the schedules table. Forward-only; the shared enforce_referenced_user_role() trigger fn and
-- the services/resources/auth.users tables already exist from the cutover.
BEGIN;

-- Working blocks for one owner (professional XOR resource). Several per owner/weekday express
-- morning + afternoon. Availability is still computed (blocks minus exceptions minus booked).
CREATE TABLE schedule_blocks (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_user_id BIGINT               REFERENCES auth.users(id) ON DELETE CASCADE,
    resource_id          BIGINT               REFERENCES resources(id)  ON DELETE CASCADE,
    weekday              VARCHAR(3)  NOT NULL CHECK (weekday IN ('sun','mon','tue','wed','thu','fri','sat')),
    start_time           TIME        NOT NULL,
    end_time             TIME        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schedule_blocks_one_owner CHECK (
        (professional_user_id IS NOT NULL AND resource_id IS NULL) OR
        (professional_user_id IS NULL AND resource_id IS NOT NULL)),
    CONSTRAINT schedule_blocks_time_order CHECK (end_time > start_time)
);
CREATE INDEX idx_schedule_blocks_professional ON schedule_blocks (professional_user_id, weekday);
CREATE INDEX idx_schedule_blocks_resource     ON schedule_blocks (resource_id, weekday);

CREATE TRIGGER schedule_blocks_professional_user_role
    BEFORE INSERT OR UPDATE ON schedule_blocks
    FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id', 'Professional');

-- Which services a professional block offers, with optional per-block overrides (NULL → service
-- default). professional_user_id is denormalized from the owning block so the row scopes exactly
-- like schedule_blocks; a trigger keeps it equal to the block's owner. Resource blocks get none.
CREATE TABLE schedule_block_services (
    id                   BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_user_id BIGINT        NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
    schedule_block_id    BIGINT        NOT NULL REFERENCES schedule_blocks(id) ON DELETE CASCADE,
    service_id           BIGINT        NOT NULL REFERENCES services(id)        ON DELETE CASCADE,
    duration_minutes     INTEGER                CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    price_ars            NUMERIC(12,2)          CHECK (price_ars IS NULL OR price_ars >= 0),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT schedule_block_services_unique UNIQUE (schedule_block_id, service_id)
);
CREATE INDEX idx_schedule_block_services_professional ON schedule_block_services (professional_user_id);
CREATE INDEX idx_schedule_block_services_block        ON schedule_block_services (schedule_block_id);

CREATE TRIGGER schedule_block_services_professional_user_role
    BEFORE INSERT OR UPDATE ON schedule_block_services
    FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id', 'Professional');

-- Keep the denormalized owner honest: it must equal the block's professional owner.
CREATE FUNCTION enforce_block_service_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    block_owner BIGINT;
BEGIN
    SELECT professional_user_id INTO block_owner FROM schedule_blocks WHERE id = NEW.schedule_block_id;
    IF block_owner IS NULL THEN
        RAISE EXCEPTION 'schedule_block_services may only attach to a professional-owned block (block %)', NEW.schedule_block_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.professional_user_id <> block_owner THEN
        RAISE EXCEPTION 'schedule_block_services.professional_user_id (%) must equal the block owner (%)', NEW.professional_user_id, block_owner
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER schedule_block_services_owner_match
    BEFORE INSERT OR UPDATE ON schedule_block_services
    FOR EACH ROW EXECUTE FUNCTION enforce_block_service_owner();

-- Booking window: a client may request from today+min up to today+max days ahead.
ALTER TABLE businesses
    ADD COLUMN min_booking_days INTEGER NOT NULL DEFAULT 0 CHECK (min_booking_days >= 0),
    ADD COLUMN max_booking_days INTEGER          CHECK (max_booking_days IS NULL OR max_booking_days >= 0);

-- Per-service override; NULL → falls back to the business window.
ALTER TABLE professional_services
    ADD COLUMN min_booking_days INTEGER CHECK (min_booking_days IS NULL OR min_booking_days >= 0),
    ADD COLUMN max_booking_days INTEGER CHECK (max_booking_days IS NULL OR max_booking_days >= 0);

-- Backfill blocks from every schedules.weekly entry (one block per weekday interval).
INSERT INTO schedule_blocks (professional_user_id, resource_id, weekday, start_time, end_time)
SELECT s.professional_user_id, s.resource_id, d.key,
       (elem->>'start')::time, (elem->>'end')::time
FROM schedules s
CROSS JOIN LATERAL jsonb_each(s.weekly)        AS d(key, value)
CROSS JOIN LATERAL jsonb_array_elements(d.value) AS elem;

-- Backfill block-services: every professional block offers each service the professional is bound
-- to, at the service default (NULL overrides). Resource blocks (professional_user_id NULL) get none.
INSERT INTO schedule_block_services (professional_user_id, schedule_block_id, service_id, duration_minutes, price_ars)
SELECT b.professional_user_id, b.id, ps.service_id, NULL, NULL
FROM schedule_blocks b
JOIN professional_services ps ON ps.professional_user_id = b.professional_user_id
WHERE b.professional_user_id IS NOT NULL;

-- The opaque weekly blob is fully superseded. Its trigger drops with the table.
DROP TABLE schedules;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_blocks         TO aida26_user';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_block_services TO aida26_user';
    END IF;
END
$$;

COMMIT;
