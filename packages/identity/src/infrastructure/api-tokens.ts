import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

import type { DataRegion } from '../domain/context.js';

// `luma_<cell>_` names the cell that issued the token, 43 characters carry 256 random bits and
// eight hex digits are a CRC-32 checksum, so secret scanners and the API recognize typos and
// truncated tokens without a database lookup.
const tokenPattern = /^luma_(au|eu|us)_[A-Za-z0-9_-]{43}([0-9a-f]{8})$/;

const regions: Readonly<Record<string, DataRegion>> = {
  au: 'AU',
  eu: 'EU',
  us: 'US',
};

const checksum = (body: string) => crc32(body).toString(16).padStart(8, '0');

/** Hashes a token for storage and lookup; only hashes reach the database. */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a new API token for the cell, with its storage hash and the last four characters. */
export function createApiToken(region: DataRegion) {
  const body = `luma_${region.toLowerCase()}_${randomBytes(32).toString('base64url')}`;
  const token = `${body}${checksum(body)}`;

  return { token, hash: hashApiToken(token), lastFour: token.slice(-4) };
}

/**
 * Reads the issuing cell of a well-formed token with a valid checksum, or null for anything
 * else. A well-formed token is not proof of anything until its hash is found.
 */
export function apiTokenRegion(token: string): DataRegion | null {
  const match = tokenPattern.exec(token);
  if (!match || checksum(token.slice(0, -8)) !== match[2]) return null;

  return regions[match[1]!] ?? null;
}
