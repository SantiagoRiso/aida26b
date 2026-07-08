-- Which services each professional offers. Business is derived through the professional's
-- auth.users row (same pattern as client_professional_services). A pure link table, hard-deletable.
BEGIN;

CREATE TABLE professional_services (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_user_id BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    service_id           BIGINT      NOT NULL REFERENCES services(id)   ON DELETE CASCADE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT professional_services_unique UNIQUE (professional_user_id, service_id)
);

CREATE INDEX idx_ps_professional_user_id ON professional_services(professional_user_id);
CREATE INDEX idx_ps_service_id           ON professional_services(service_id);

-- Enforce that professional_user_id references a user whose role is 'Professional'.
CREATE TRIGGER ps_professional_user_role
  BEFORE INSERT OR UPDATE ON professional_services
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id', 'Professional');

-- Least-privilege: the app role manages offerings via generic CRUD (create/read/delete; no update).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON professional_services TO aida26_user';
  END IF;
END
$$;

COMMIT;
