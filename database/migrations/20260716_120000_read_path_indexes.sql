CREATE INDEX idx_ledger_entries_client_created_at
    ON ledger_entries (client_user_id, created_at DESC);

CREATE INDEX idx_audit_events_business_created_at
    ON audit_events (business_id, created_at DESC);
