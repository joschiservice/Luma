-- The interface language a person chose, for email sent outside a request. NULL until they
-- choose a language or sign in; mail then uses English.
ALTER TABLE users ADD COLUMN locale text CHECK (locale IN ('en','de'));

-- The provider's ID for each accepted message. Delivery events count only for mail this
-- deployment sent, which matters when environments share a provider account. No address or
-- content is stored; rows are removed after 30 days.
CREATE TABLE mail_receipts (
 provider_id text PRIMARY KEY CHECK (length(provider_id) BETWEEN 1 AND 200),
 message_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','delivered','delayed','bounced','complained')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_receipts_created ON mail_receipts(created_at);

-- An account whose address bounced permanently or reported Luma's mail as spam. Optional
-- notifications skip it while the address is unchanged, until a later message is delivered.
-- Rows are erased with the account.
CREATE TABLE mail_suppressions (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email text NOT NULL,
 reason text NOT NULL CHECK (reason IN ('bounced','complained')),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE,DELETE ON mail_receipts,mail_suppressions TO luma_identity;
