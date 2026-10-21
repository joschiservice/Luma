import type { Pool } from 'pg';
import { expect, it } from 'vitest';

import { createApiCredentials } from './api-apps.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const pool = {} as Pool;

it('reports the tighter of the credential and workspace limits', async () => {
  const credentials = createApiCredentials(pool, 'AU', { enabled: true });

  expect(await credentials.admit(tenant, 'first')).toEqual({
    limit: 600,
    remaining: 599,
    reset: 60,
  });
  for (let index = 0; index < 1_300; index++)
    await credentials.admit(tenant, `other-${index % 10}`);
  expect(await credentials.admit(tenant, 'first')).toEqual({
    limit: 1_800,
    remaining: 498,
    reset: 60,
  });
  for (let index = 0; index < 498; index++)
    await credentials.admit(tenant, 'first');
  expect(await credentials.admit(tenant, 'first')).toMatchObject({
    limit: 1_800,
    remaining: -1,
  });
});

it('counts nothing when limits are off', async () => {
  const credentials = createApiCredentials(pool, 'AU', { enabled: false });

  expect(await credentials.admit(tenant, 'first')).toBeNull();
});
