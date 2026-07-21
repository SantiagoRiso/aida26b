BEGIN;

-- Email is the login identity, so any account that can log in must carry one.
-- Complements users_client_or_email (staff always carry an email) rather than restating it:
-- together the only email-less row left legal is the contact-only client, who has no username
-- either. Existing contact-only clients (username NULL, email NULL) satisfy both.
ALTER TABLE auth.users
    ADD CONSTRAINT users_login_requires_email
    CHECK (username IS NULL OR email IS NOT NULL);

COMMIT;
