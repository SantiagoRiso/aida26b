BEGIN;

-- professional_services gained per-service booking-window columns (min/max_booking_days), and its
-- descriptor now allows a scoped update of them. The original grant was create/read/delete only, so
-- the app role could never persist an override — widen it to the UPDATE that path needs.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
        EXECUTE 'GRANT UPDATE ON professional_services TO aida26_user';
    END IF;
END
$$;

COMMIT;
