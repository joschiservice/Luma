-- Second factors and passkeys are credentials, so they follow the regional bootstrap exception
-- for users, sessions and accounts: identity-only grants and no tenant scope.
ALTER TABLE users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE two_factors (
 id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 secret text NOT NULL, backup_codes text NOT NULL, verified boolean NOT NULL DEFAULT true,
 failed_verification_count integer NOT NULL DEFAULT 0, locked_until timestamptz
);
CREATE TABLE passkeys (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text CHECK (char_length(name) <= 200), credential_id text NOT NULL UNIQUE,
 public_key text NOT NULL, counter bigint NOT NULL CHECK (counter >= 0),
 device_type text NOT NULL, backed_up boolean NOT NULL, transports text, aaguid text,
 created_at timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON two_factors, passkeys TO luma_identity;
