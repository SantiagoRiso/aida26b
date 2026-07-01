-- Per-block granularity reaches schedule_exceptions: a changed-hours "available" exception
-- (is_unavailable = false with a start/end window) must declare a positive slot granularity,
-- while a full-day / blocked exception carries none. schedule_exceptions already grants
-- INSERT/UPDATE/DELETE to the app role, so no new grant is needed.

ALTER TABLE schedule_exceptions
    ADD COLUMN granularity_minutes INTEGER;

ALTER TABLE schedule_exceptions
    ADD CONSTRAINT schedule_exceptions_granularity_check CHECK (
        (is_unavailable = false
            AND start_time IS NOT NULL AND end_time IS NOT NULL
            AND granularity_minutes IS NOT NULL AND granularity_minutes > 0)
        OR
        ((is_unavailable = true OR start_time IS NULL OR end_time IS NULL)
            AND granularity_minutes IS NULL)
    );
