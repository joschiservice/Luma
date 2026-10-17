-- Account mail also confirms email addresses and announces new sign-in factors. Confirmation
-- links are encrypted like reset links. Existing accounts keep their unconfirmed state: nothing
-- they did before proved that their owner controls the address.
ALTER TABLE password_security_mail DROP CONSTRAINT password_security_mail_kind_check;
ALTER TABLE password_security_mail DROP CONSTRAINT password_security_mail_check;
ALTER TABLE password_security_mail
 ADD COLUMN factor text,
 ADD CONSTRAINT password_security_mail_factor_value_check CHECK (factor IN ('passkey', 'authenticator')),
 ADD CONSTRAINT password_security_mail_kind_check CHECK (kind IN ('reset', 'changed', 'verify', 'factor_added')),
 ADD CONSTRAINT password_security_mail_check CHECK (kind IN ('reset', 'verify') OR reset_token IS NULL),
 ADD CONSTRAINT password_security_mail_factor_kind_check CHECK ((kind = 'factor_added') = (factor IS NOT NULL));

-- Sign-in lockout counts recent password failures of unknown addresses by their keyed hash.
CREATE INDEX account_security_events_email_failures ON account_security_events(email_hash, created_at) WHERE email_hash IS NOT NULL;
