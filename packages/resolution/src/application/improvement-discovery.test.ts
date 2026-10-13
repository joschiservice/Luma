import { expect, it, vi } from 'vitest';

import { createImprovementDiscovery } from './improvement-discovery.js';
import { testContext } from './tenant-context.fixture.js';

it('keeps the release disabled and refreshed authorization ahead of all discovery reads', async () => {
  const read = vi.fn(async () => []);
  const fresh = vi.fn(async () => testContext());
  const enabled = vi.fn(async () => false);
  const service = createImprovementDiscovery({
    read,
    refreshContext: fresh,
    enabled,
    hash: JSON.stringify,
    now: () => new Date('2026-09-30T12:00:00Z'),
  });
  await expect(service.discover(testContext())).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(read).not.toHaveBeenCalled();
  enabled.mockResolvedValue(true);
  fresh.mockResolvedValue(testContext({ role: 'member' }));
  await expect(service.discover(testContext())).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(read).not.toHaveBeenCalled();
  fresh.mockResolvedValue(testContext());
  await expect(service.discover(testContext())).resolves.toMatchObject({
    windowDays: 30,
    minimumIncidents: 3,
    items: [],
  });
  expect(read).toHaveBeenCalledTimes(1);
});
