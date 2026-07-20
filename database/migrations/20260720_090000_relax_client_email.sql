BEGIN;

-- Contact-only clients (walk-ins / phone bookings) are recorded without an email address.
-- Supersedes the "email/display_name remain required" note in
-- 20260712_100000_relax_client_login_credentials.sql: email is now optional, for Clients only.
-- One physical table serves all four roles, so a bare DROP NOT NULL would also let staff
-- accounts lose their email; the role-conditional CHECK keeps it mandatory for everyone else.
-- users_email_unique still holds: Postgres treats NULLs as distinct, so any number of
-- clients may have no email at all (the same reasoning username relies on).
-- display_name stays required for every role.
ALTER TABLE auth.users ALTER COLUMN email DROP NOT NULL;

ALTER TABLE auth.users
    ADD CONSTRAINT users_client_or_email
    CHECK (role = 'Client' OR email IS NOT NULL);

COMMIT;
