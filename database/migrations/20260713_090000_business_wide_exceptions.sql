BEGIN;

-- A schedule exception may now belong to the whole business (a clinic-wide closure), not only a
-- single professional or resource. The owner becomes exactly-one-of-three: professional XOR resource
-- XOR business. A business-owned row blocks every professional and resource in that business on the
-- date; the availability engine unions it into each owner's exceptions. business_id is set ONLY for
-- these business-wide rows (stamped server-side by the closures endpoint); per-owner rows leave it
-- null and keep deriving their business through the owner.
ALTER TABLE schedule_exceptions
    ADD COLUMN business_id BIGINT REFERENCES businesses(id) ON DELETE CASCADE;

ALTER TABLE schedule_exceptions DROP CONSTRAINT schedule_exceptions_one_owner;
ALTER TABLE schedule_exceptions ADD CONSTRAINT schedule_exceptions_one_owner CHECK (
    num_nonnulls(professional_user_id, resource_id, business_id) = 1);

-- The availability engine reads business-wide rows by (business_id, date) on every owner lookup.
CREATE INDEX schedule_exceptions_business_date_idx
    ON schedule_exceptions (business_id, exception_date) WHERE business_id IS NOT NULL;

COMMIT;
