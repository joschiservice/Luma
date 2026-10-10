import { describe, expect, it } from 'vitest';

import {
  decodeSecurityEventCursor,
  encodeSecurityEventCursor,
  signInFailureReason,
} from './security-events.js';

describe('security events', () => {
  it('maps sign-in errors to categories without submitted values', () => {
    expect(signInFailureReason('INVALID_EMAIL_OR_PASSWORD')).toBe(
      'invalid-credentials',
    );
    expect(signInFailureReason('INVALID_BACKUP_CODE')).toBe('invalid-code');
    expect(signInFailureReason('INVALID_TWO_FACTOR_COOKIE')).toBe(
      'challenge-expired',
    );
    expect(signInFailureReason('ACCOUNT_DISABLED')).toBe('account-disabled');
    expect(signInFailureReason(undefined)).toBe('rejected');
  });

  it('round-trips page cursors and rejects malformed ones', () => {
    const cursor = {
      createdAt: new Date('2026-10-09T12:00:00.123Z'),
      id: '6f1f8f5e-6b8a-4c1b-9d55-2f0f6a1b7c3d',
    };
    expect(
      decodeSecurityEventCursor(encodeSecurityEventCursor(cursor)),
    ).toEqual(cursor);
    for (const value of [
      'not-a-cursor',
      Buffer.from('2026-10-09|not-a-uuid').toString('base64url'),
      Buffer.from(`never|${cursor.id}`).toString('base64url'),
      Buffer.from(`2026-10-09T12:00:00Z|${cursor.id}|extra`).toString(
        'base64url',
      ),
    ])
      expect(decodeSecurityEventCursor(value)).toBeNull();
  });
});
