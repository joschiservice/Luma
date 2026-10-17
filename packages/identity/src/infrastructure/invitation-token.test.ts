import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createInvitationToken } from './invitation-token.js';

const secret = 'q8Zr0v3XkLp2Wm9TfYc6Hn1Bd4Gs7Ja5';
const token = createInvitationToken(secret);

describe('invitation tokens', () => {
  it('issues stable proofs per generation with a derived key, not the root secret', () => {
    const rootKeyed = createHmac('sha256', secret)
      .update('invitation:tenant:invite:1')
      .digest('hex');

    expect(token('tenant', 'invite', 1)).toMatch(/^[0-9a-f]{64}$/);
    expect(token('tenant', 'invite', 1)).toBe(token('tenant', 'invite', 1));
    expect(token('tenant', 'invite', 1)).not.toBe(rootKeyed);
    expect(token('tenant', 'invite', 2)).not.toBe(token('tenant', 'invite', 1));
    expect(
      createInvitationToken(`${secret}-other`)('tenant', 'invite', 1),
    ).not.toBe(token('tenant', 'invite', 1));
  });
});
