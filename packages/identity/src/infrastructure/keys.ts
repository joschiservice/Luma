import { hkdfSync } from 'node:crypto';

/** Uses of the auth secret outside Better Auth; each gets its own key. */
export type KeyPurpose =
  'invitation-token' | 'security-event-email' | 'password-mail';

/**
 * Derives a 256-bit key for one purpose from the root auth secret with HKDF-SHA256, returned as
 * 64 hex characters. The same inputs always give the same key, so values keyed with it survive
 * restarts; a different purpose or secret gives an unrelated key. Better Auth keeps the root
 * secret for its own cookies and tokens.
 */
export function deriveKey(secret: string, purpose: KeyPurpose): string {
  return Buffer.from(
    hkdfSync('sha256', secret, 'luma-auth-secret', `luma:${purpose}:v1`, 32),
  ).toString('hex');
}
