BEGIN;

-- Calendar grants are created and revoked through explicit staff endpoints running as the app role.
-- The cutover left calendar_grants SELECT-only; widen it to the writes those endpoints need.
-- INSERT = grant, DELETE = revoke (a hard delete; grants carry no soft-delete, so no UPDATE).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
        EXECUTE 'GRANT INSERT, DELETE ON calendar_grants TO aida26_user';
    END IF;
END
$$;

COMMIT;
