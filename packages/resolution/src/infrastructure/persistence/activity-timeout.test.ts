import type { TenantDatabase } from '@luma/platform';
import { expect, it } from 'vitest';

import { testContext } from '../../application/tenant-context.fixture.js';
import { createActivityStore } from './activity.js';

const failing = (error: Error): TenantDatabase =>
  ({ transaction: () => Promise.reject(error) }) as unknown as TenantDatabase;
const query = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  limit: 30,
};

it('asks for a narrower read when a statement times out', async () => {
  const timeout = Object.assign(new Error('canceling statement'), {
    code: '57014',
  });
  const store = createActivityStore(failing(timeout));

  await expect(store.list(testContext(), query)).rejects.toMatchObject({
    statusCode: 503,
    message: expect.stringContaining('shorter date range'),
  });
  await expect(store.counts(testContext(), query)).rejects.toMatchObject({
    statusCode: 503,
  });
});

it('keeps other database failures as they are', async () => {
  const failure = new Error('connection lost');

  await expect(
    createActivityStore(failing(failure)).list(testContext(), query),
  ).rejects.toBe(failure);
});
