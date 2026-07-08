-- Adds an optional national ID (DNI) to persons, surfaced on the Clients entity for
-- identification and search. Unique per business among non-null values so the same person
-- can't be entered twice; blank/unknown DNIs stay allowed for any number of clients.
BEGIN;

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS dni TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_business_dni
  ON auth.users (business_id, dni)
  WHERE dni IS NOT NULL;

-- Re-declare the secret-free read view so generic reads of clients/professionals can project
-- dni. New columns must be appended at the end for CREATE OR REPLACE VIEW to accept it.
CREATE OR REPLACE VIEW auth.users_directory AS
SELECT
    id,
    business_id,
    username,
    email,
    display_name,
    phone,
    bio,
    notes,
    role,
    is_active,
    must_change_password,
    deleted_at,
    deleted_by_user_id,
    created_at,
    updated_at,
    dni
FROM auth.users;

COMMIT;
