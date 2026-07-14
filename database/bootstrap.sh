#!/bin/sh
# Creates the two least-privilege DB roles and the owner-owned application database on a fresh
# cluster. Runs once via /docker-entrypoint-initdb.d (the postgres image sources it on first
# init), or by hand: `POSTGRES_USER=postgres DB_NAME=... sh database/bootstrap.sh`.
#
# aida26_owner owns the database and all schema objects; migrations run as it. aida26_user is the
# runtime app role and gets only explicit per-table grants from migrations.
#
# Credentials come entirely from the environment — the same DB_* vars the app connects with — so
# there is one source of truth and no SQL-side copy to drift from .env. Missing vars fail fast.
: "${POSTGRES_USER:?}" "${DB_NAME:?}" "${DB_OWNER_USER:?}" "${DB_OWNER_PASSWORD:?}" "${DB_USER:?}" "${DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -v owner="$DB_OWNER_USER" -v owner_pw="$DB_OWNER_PASSWORD" \
  -v app="$DB_USER" -v app_pw="$DB_PASSWORD" -v dbname="$DB_NAME" <<'EOSQL'
-- CREATE ROLE/DATABASE can't be guarded by IF NOT EXISTS; \gexec runs the generated statement
-- only when the role/db is absent. format() safely quotes the env values (%I identifier, %L literal).
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'owner', :'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner')\gexec

SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'app', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app')\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'dbname', :'owner')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'dbname')\gexec

\c :"dbname"

-- No broad default privileges; per-table grants are declared in the migrations.
GRANT CONNECT ON DATABASE :"dbname" TO :"app";
GRANT USAGE   ON SCHEMA public      TO :"app";
EOSQL
