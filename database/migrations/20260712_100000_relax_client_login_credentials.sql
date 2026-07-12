BEGIN;

-- Contact-only clients (walk-ins / phone bookings) are recorded without login credentials.
-- username/password become optional; the UNIQUE index on username still holds because Postgres
-- treats multiple NULLs as distinct. email/display_name remain required.
ALTER TABLE auth.users ALTER COLUMN username      DROP NOT NULL;
ALTER TABLE auth.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE auth.users ALTER COLUMN password_salt DROP NOT NULL;

COMMIT;
