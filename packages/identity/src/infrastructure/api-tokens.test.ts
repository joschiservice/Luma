import { expect, it } from 'vitest';

import { apiTokenRegion, createApiToken, hashApiToken } from './api-tokens.js';

it('creates distinct tokens that name their cell and pass their checksum', () => {
  const first = createApiToken('AU');
  const second = createApiToken('AU');

  expect(first.token).toMatch(/^luma_au_[A-Za-z0-9_-]{43}[0-9a-f]{8}$/);
  expect(first.token).not.toBe(second.token);
  expect(first.hash).toBe(hashApiToken(first.token));
  expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(first.lastFour).toBe(first.token.slice(-4));
  expect(apiTokenRegion(first.token)).toBe('AU');
  expect(apiTokenRegion(createApiToken('EU').token)).toBe('EU');
});

it('rejects typos, truncation and other formats without a lookup', () => {
  const { token } = createApiToken('AU');
  const changed = `${token.slice(0, 20)}${token[20] === 'x' ? 'y' : 'x'}${token.slice(21)}`;

  expect(apiTokenRegion(changed)).toBeNull();
  expect(apiTokenRegion(token.slice(0, -1))).toBeNull();
  expect(apiTokenRegion(token.replace('luma_au_', 'luma_xx_'))).toBeNull();
  expect(apiTokenRegion('')).toBeNull();
});
