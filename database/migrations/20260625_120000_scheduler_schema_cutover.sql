BEGIN;

-- Drop the broad default privileges so the app role gets only the explicit
-- per-table grants below. Skipped when aida26_owner is absent (single-role setups).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_owner') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE aida26_owner IN SCHEMA public
        REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM aida26_user';
  END IF;
END
$$;

CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;

CREATE TABLE businesses (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT     NOT NULL,
    timezone      TEXT     NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    currency_code CHAR(3)  NOT NULL DEFAULT 'ARS' CHECK (currency_code = 'ARS'),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth.users (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- RESTRICT, not SET NULL: a null business_id means super-admin (see CHECK below),
    -- so deleting a tenant must never silently promote its staff or clients to see-all.
    business_id           BIGINT       REFERENCES businesses(id) ON DELETE RESTRICT,
    username              VARCHAR(80)  NOT NULL UNIQUE,
    email                 VARCHAR(255) NOT NULL,
    display_name          TEXT         NOT NULL,
    phone                 VARCHAR(50),
    bio                   TEXT,
    notes                 TEXT,
    password_hash         TEXT         NOT NULL,
    password_salt         TEXT         NOT NULL,
    role                  VARCHAR(20)  NOT NULL CHECK (role IN ('Admin','Professional','Receptionist','Client')),
    is_active             BOOLEAN      NOT NULL DEFAULT true,
    must_change_password  BOOLEAN      NOT NULL DEFAULT false,
    deleted_at            TIMESTAMPTZ,
    deleted_by_user_id    BIGINT       REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT users_email_unique UNIQUE (email),
    -- A null business_id is the super-admin marker; only Admins may hold it. Every
    -- other role is tenant-bound, so authorization can treat null business as see-all.
    CONSTRAINT users_admin_or_business
        CHECK (business_id IS NOT NULL OR role = 'Admin'),
    CONSTRAINT users_soft_delete_consistency
        CHECK ((deleted_at IS NULL AND deleted_by_user_id IS NULL) OR deleted_at IS NOT NULL)
);

CREATE TABLE auth.sessions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_sessions_user_id    ON auth.sessions(user_id);
CREATE INDEX idx_auth_sessions_expires_at ON auth.sessions(expires_at);
CREATE INDEX idx_auth_users_business_id   ON auth.users(business_id);

CREATE TABLE resources (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id        BIGINT      NOT NULL REFERENCES businesses(id),
    name               TEXT        NOT NULL,
    description        TEXT,
    deleted_at         TIMESTAMPTZ,
    deleted_by_user_id BIGINT      REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT resources_soft_delete_consistency
        CHECK ((deleted_at IS NULL AND deleted_by_user_id IS NULL) OR deleted_at IS NOT NULL)
);
CREATE INDEX idx_resources_business_id ON resources(business_id);

CREATE TABLE services (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id              BIGINT        NOT NULL REFERENCES businesses(id),
    name                     TEXT          NOT NULL,
    description              TEXT,
    default_duration_minutes INTEGER       NOT NULL DEFAULT 60 CHECK (default_duration_minutes > 0),
    default_price_ars        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (default_price_ars >= 0),
    deleted_at               TIMESTAMPTZ,
    deleted_by_user_id       BIGINT        REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT services_soft_delete_consistency
        CHECK ((deleted_at IS NULL AND deleted_by_user_id IS NULL) OR deleted_at IS NOT NULL)
);
CREATE INDEX idx_services_business_id ON services(business_id);

-- Optional per-client price for a professional's service; absent means the service default.
CREATE TABLE client_professional_services (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_user_id       BIGINT        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    professional_user_id BIGINT        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    service_id           BIGINT        NOT NULL REFERENCES services(id)   ON DELETE CASCADE,
    price_ars            NUMERIC(12,2) NOT NULL CHECK (price_ars >= 0),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT client_professional_services_unique UNIQUE (client_user_id, professional_user_id, service_id)
);
CREATE INDEX idx_cps_client_user_id       ON client_professional_services(client_user_id);
CREATE INDEX idx_cps_professional_user_id ON client_professional_services(professional_user_id);
CREATE INDEX idx_cps_service_id           ON client_professional_services(service_id);

-- Recurring weekly hours for one professional or resource (exactly one owner).
-- Availability is computed from this minus exceptions minus booked appointments;
-- nothing derived is stored. The weekly shape is validated in the shared domain layer.
CREATE TABLE schedules (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_user_id BIGINT      UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    resource_id          BIGINT      UNIQUE REFERENCES resources(id)  ON DELETE CASCADE,
    weekly               JSONB       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(weekly) = 'object'),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schedules_one_owner CHECK (
        (professional_user_id IS NOT NULL AND resource_id IS NULL) OR
        (professional_user_id IS NULL AND resource_id IS NOT NULL))
);

CREATE TABLE schedule_exceptions (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_user_id BIGINT      REFERENCES auth.users(id) ON DELETE CASCADE,
    resource_id          BIGINT      REFERENCES resources(id)  ON DELETE CASCADE,
    exception_date       DATE        NOT NULL,
    is_unavailable       BOOLEAN     NOT NULL DEFAULT true,
    start_time           TIME,
    end_time             TIME,
    reason               TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schedule_exceptions_one_owner CHECK (
        (professional_user_id IS NOT NULL AND resource_id IS NULL) OR
        (professional_user_id IS NULL AND resource_id IS NOT NULL)),
    CONSTRAINT schedule_exceptions_time_range_check
        CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time)
);
CREATE INDEX idx_schedule_exceptions_professional_user_id ON schedule_exceptions(professional_user_id);
CREATE INDEX idx_schedule_exceptions_resource_id          ON schedule_exceptions(resource_id);
CREATE INDEX idx_schedule_exceptions_date                 ON schedule_exceptions(exception_date);

CREATE TABLE appointments (
    id                   BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_user_id       BIGINT        NOT NULL REFERENCES auth.users(id),
    professional_user_id BIGINT        NOT NULL REFERENCES auth.users(id),
    resource_id          BIGINT                 REFERENCES resources(id),
    service_id           BIGINT        NOT NULL REFERENCES services(id),
    starts_at            TIMESTAMPTZ   NOT NULL,
    duration_minutes     INTEGER       NOT NULL CHECK (duration_minutes > 0),
    ends_at              TIMESTAMPTZ   NOT NULL,
    state                VARCHAR(20)   NOT NULL DEFAULT 'requested'
                             CHECK (state IN ('requested','scheduled','completed','canceled','no_show','rejected')),
    name                 TEXT,
    description          TEXT,
    -- Booked price; unaffected by later service or override price changes.
    price                NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    override_conflict    BOOLEAN       NOT NULL DEFAULT false,
    override_actor_id    BIGINT                 REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_client_user_id       ON appointments(client_user_id);
CREATE INDEX idx_appointments_professional_user_id ON appointments(professional_user_id);
CREATE INDEX idx_appointments_resource_id          ON appointments(resource_id);
CREATE INDEX idx_appointments_starts_at            ON appointments(starts_at);
CREATE INDEX idx_appointments_state                ON appointments(state);

-- ends_at is kept in sync by a trigger; a generated column can't be used because
-- timestamptz arithmetic is not immutable.
CREATE FUNCTION set_appointment_ends_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.duration_minutes);
    RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_set_ends_at
    BEFORE INSERT OR UPDATE OF starts_at, duration_minutes ON appointments
    FOR EACH ROW EXECUTE FUNCTION set_appointment_ends_at();

-- Immutable: balance is SUM over entries; corrections are new adjustment rows.
CREATE TABLE ledger_entries (
    id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_user_id BIGINT        NOT NULL REFERENCES auth.users(id),
    appointment_id BIGINT                 REFERENCES appointments(id) ON DELETE SET NULL,
    entry_type     VARCHAR(20)   NOT NULL CHECK (entry_type IN ('charge','payment','adjustment')),
    amount_ars     NUMERIC(12,2) NOT NULL CHECK (amount_ars >= 0),
    description    TEXT,
    actor_user_id  BIGINT                 REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_entries_client_user_id  ON ledger_entries(client_user_id);
CREATE INDEX idx_ledger_entries_appointment_id ON ledger_entries(appointment_id);

-- Append-only. business_id is the event's scope and isn't reliably derivable, so it stays.
CREATE TABLE audit_events (
    id            BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id   BIGINT       NOT NULL REFERENCES businesses(id),
    actor_user_id BIGINT                REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type    VARCHAR(80)  NOT NULL,
    entity_type   VARCHAR(80),
    entity_id     BIGINT,
    outcome       VARCHAR(20)  NOT NULL CHECK (outcome IN ('success','failure','denied')),
    ip            TEXT,
    details       JSONB        NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_events_business_id ON audit_events(business_id);
CREATE INDEX idx_audit_events_created_at  ON audit_events(created_at);

CREATE TABLE calendar_grants (
    id                   BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    professional_user_id BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    grantee_user_id      BIGINT      NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT calendar_grants_unique UNIQUE (professional_user_id, grantee_user_id)
);
CREATE INDEX idx_calendar_grants_professional_user_id ON calendar_grants(professional_user_id);
CREATE INDEX idx_calendar_grants_grantee_user_id      ON calendar_grants(grantee_user_id);

-- FK columns that reference auth.users must point to a user with the declared role.
CREATE FUNCTION enforce_referenced_user_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ref_col   TEXT   := TG_ARGV[0];
  want_role TEXT   := TG_ARGV[1];
  ref_id    BIGINT := (to_jsonb(NEW) ->> ref_col)::BIGINT;
  actual    TEXT;
BEGIN
  IF ref_id IS NULL THEN RETURN NEW; END IF;
  SELECT role INTO actual FROM auth.users WHERE id = ref_id;
  IF actual IS DISTINCT FROM want_role THEN
    RAISE EXCEPTION '%.% must reference a % (user % has role %)',
      TG_TABLE_NAME, ref_col, want_role, ref_id, COALESCE(actual,'<missing>')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cps_client_user_role
  BEFORE INSERT OR UPDATE ON client_professional_services
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('client_user_id','Client');

CREATE TRIGGER cps_professional_user_role
  BEFORE INSERT OR UPDATE ON client_professional_services
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id','Professional');

CREATE TRIGGER schedules_professional_user_role
  BEFORE INSERT OR UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id','Professional');

CREATE TRIGGER schedule_exceptions_professional_user_role
  BEFORE INSERT OR UPDATE ON schedule_exceptions
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id','Professional');

CREATE TRIGGER appointments_client_user_role
  BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('client_user_id','Client');

CREATE TRIGGER appointments_professional_user_role
  BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id','Professional');

CREATE TRIGGER ledger_entries_client_user_role
  BEFORE INSERT OR UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('client_user_id','Client');

CREATE TRIGGER calendar_grants_professional_user_role
  BEFORE INSERT OR UPDATE ON calendar_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_referenced_user_role('professional_user_id','Professional');

-- Per-table grants for the app role; skipped in single-role setups.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aida26_user') THEN
    -- DELETE on users withheld: users are deactivated, never hard-deleted.
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO aida26_user';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON auth.users    TO aida26_user';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON auth.sessions TO aida26_user';

    -- Soft-deleted via UPDATE, so no DELETE granted.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON resources                    TO aida26_user';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON services                     TO aida26_user';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON client_professional_services TO aida26_user';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON schedules                    TO aida26_user';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_exceptions  TO aida26_user';

    EXECUTE 'GRANT SELECT ON calendar_grants TO aida26_user';
    EXECUTE 'GRANT SELECT ON appointments    TO aida26_user';
    EXECUTE 'GRANT SELECT ON ledger_entries  TO aida26_user';
    EXECUTE 'GRANT SELECT ON audit_events    TO aida26_user';
  END IF;
END
$$;

COMMIT;
