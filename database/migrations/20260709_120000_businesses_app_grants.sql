-- The business-settings endpoints read and update businesses as the app role, which the
-- cutover grants never covered. No INSERT/DELETE: businesses are provisioned by the owner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
    EXECUTE 'GRANT SELECT, UPDATE ON businesses TO aida26_user';
  END IF;
END
$$;
