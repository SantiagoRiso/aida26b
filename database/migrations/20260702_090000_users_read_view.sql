BEGIN;

-- The generic GET route projects "SELECT * FROM <sqlTable>" — pointing it straight at
-- auth.users would leak password_hash/password_salt in the admin Usuarios JSON response.
-- This view is the safe read surface: every column the users SSOT entity is allowed to
-- show, and nothing auth-sensitive. Generic CRUD for users stays read-only (see SSOT),
-- so no INSERT/UPDATE/DELETE projection is needed.
CREATE VIEW auth.users_directory AS
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
    updated_at
FROM auth.users;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
    EXECUTE 'GRANT SELECT ON auth.users_directory TO aida26_user';
  END IF;
END
$$;

COMMIT;
