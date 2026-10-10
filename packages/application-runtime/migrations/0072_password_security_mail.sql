-- Account mail has no tenant scope. Reset credentials are encrypted with the identity secret
-- and cleared after dispatch or expiry; account erasure cascades to these notices.
CREATE TABLE password_security_mail (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','de')),
 kind text NOT NULL CHECK (kind IN ('reset', 'changed')),
 reset_token text,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','failed')),
 attempts integer NOT NULL DEFAULT 0,
 first_attempt_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 CHECK (kind='reset' OR reset_token IS NULL)
);
CREATE INDEX password_security_mail_pending ON password_security_mail(next_attempt_at) WHERE state='queued';
GRANT SELECT,INSERT,UPDATE,DELETE ON password_security_mail TO luma_identity;
