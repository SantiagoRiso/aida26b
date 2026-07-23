-- A failed login against a username that matches no account resolves to no business, and a NOT NULL
-- business_id left the only two options as "invent a tenant for it" or "record nothing" — so nothing
-- was recorded, and the one attempt pattern worth watching for was the one that left no trace.
-- These events are attempts on the system rather than on any one tenant, so their scope is genuinely
-- absent, not unknown.
ALTER TABLE audit_events ALTER COLUMN business_id DROP NOT NULL;

-- Tenant-scoped reads filter on an equality against business_id and never match a NULL, so these
-- rows keep their own access path and stay out of every tenant's audit view.
CREATE INDEX idx_audit_events_tenantless_created_at
    ON audit_events (created_at DESC)
    WHERE business_id IS NULL;
