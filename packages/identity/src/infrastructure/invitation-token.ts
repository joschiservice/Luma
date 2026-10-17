import { createHash, createHmac } from 'node:crypto';

import { deriveKey } from './keys.js';

/** Hashes an invitation link proof for storage; only the hash is kept. */
export const hashInvitationToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Creates the link proof of an invitation generation, keyed with a key derived for invitations.
 * The same invitation and generation always give the same proof, so the mail worker can rebuild
 * the link whose hash settings stored.
 */
export function createInvitationToken(secret: string) {
  const key = deriveKey(secret, 'invitation-token');

  return (tenantId: string, id: string, generation: number) =>
    createHmac('sha256', key)
      .update(`invitation:${tenantId}:${id}:${generation}`)
      .digest('hex');
}
