-- Creates the two DB roles and the owner-owned application database.
-- Run as a superuser:  psql -U postgres -f database/bootstrap.sql
-- Or mount at /docker-entrypoint-initdb.d/ so the postgres image runs it on first init.
--
-- aida26_owner owns the database and all schema objects; migrations run as it.
-- aida26_user is the runtime app role and gets only explicit per-table grants from migrations.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_owner') THEN
    CREATE ROLE aida26_owner WITH LOGIN PASSWORD 'CambiaEsta_Owner!';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
    CREATE ROLE aida26_user WITH LOGIN PASSWORD 'CambiaEsta!';
  END IF;
END
$$;

-- CREATE DATABASE cannot run inside a DO block; \gexec runs the guarded statement.
SELECT 'CREATE DATABASE professional_agenda OWNER aida26_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'professional_agenda')\gexec

\c professional_agenda

-- No broad default privileges; per-table grants are declared in the migrations.
GRANT CONNECT ON DATABASE professional_agenda TO aida26_user;
GRANT USAGE   ON SCHEMA public               TO aida26_user;
