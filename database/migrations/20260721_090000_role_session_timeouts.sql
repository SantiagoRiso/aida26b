-- A stuck query, a stuck lock wait, or a transaction left open mid-request used to hold a pool
-- connection (and whatever locks it held) forever. These are role-level defaults so they apply to
-- every session that connects as the role, not just this app's own pool.
--
-- Scoped IN DATABASE (current_database(), i.e. whichever database this migration runs against)
-- rather than a bare ALTER ROLE ... SET: an unscoped SET writes one shared row in pg_authid that
-- covers the role across every database on the cluster, so two migration runs against different
-- databases (a test database and the real one, or two test databases in parallel) race on that
-- same row and Postgres raises "tuple concurrently updated". IN DATABASE keys the setting to
-- (role, database) in pg_db_role_setting instead, so concurrent runs against different databases
-- never touch the same row — and since this app only ever has one database, the effective result
-- is identical to a cluster-wide setting.
DO $$
BEGIN
    -- aida26_user (app role): bounded on all three axes. Ordinary read/write traffic finishes in
    -- well under a second; these ceilings exist to fail a stuck caller fast and give back the
    -- connection, not to constrain normal operation.
    EXECUTE format('ALTER ROLE aida26_user IN DATABASE %I SET statement_timeout = %L', current_database(), '15s');
    EXECUTE format('ALTER ROLE aida26_user IN DATABASE %I SET lock_timeout = %L', current_database(), '5s');
    EXECUTE format('ALTER ROLE aida26_user IN DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '30s');

    -- aida26_owner (migration/schema-owner role): deliberately NOT bounded on statement_timeout or
    -- lock_timeout. Migrations run as this role and must run to completion even if a DDL statement
    -- needs a longer lock wait or a backfill takes a while — killing it mid-run would leave the
    -- schema_migrations ledger and the schema itself out of sync. Only guard against a session left
    -- idle inside an open transaction (e.g. a forgotten interactive psql session), which blocks
    -- vacuum/locks without ever doing any work.
    EXECUTE format('ALTER ROLE aida26_owner IN DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '5min');
END $$;
