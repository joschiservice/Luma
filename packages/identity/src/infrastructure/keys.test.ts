import { hkdfSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveKey } from './keys.js';

const secret = 'q8Zr0v3XkLp2Wm9TfYc6Hn1Bd4Gs7Ja5';

describe('deriveKey', () => {
  it('derives stable, separate keys per purpose and secret', () => {
    const invitation = deriveKey(secret, 'invitation-token');

    expect(invitation).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveKey(secret, 'invitation-token')).toBe(invitation);
    expect(deriveKey(secret, 'security-event-email')).not.toBe(invitation);
    expect(deriveKey(secret, 'password-mail')).not.toBe(invitation);
    expect(deriveKey(`${secret}x`, 'invitation-token')).not.toBe(invitation);
    expect(invitation).not.toContain(Buffer.from(secret).toString('hex'));
  });

  it('matches HKDF-SHA256 with the documented salt and info', () => {
    expect(deriveKey(secret, 'security-event-email')).toBe(
      Buffer.from(
        hkdfSync(
          'sha256',
          secret,
          'luma-auth-secret',
          'luma:security-event-email:v1',
          32,
        ),
      ).toString('hex'),
    );
  });
});
