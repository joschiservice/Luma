import type { InstalledConnection } from '@luma/connections';
import { describe, expect, it, vi } from 'vitest';

import { createStarshipitProvider } from '../index.js';

const connection: InstalledConnection = {
  id: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
  label: 'Starshipit',
  target: { kind: 'starshipit', accountId: 'my-account' },
  permissions: ['orders.read', 'fulfillment.read', 'orders.quantity.update'],
  granted: [],
  status: 'pending',
  version: 1,
  credentialVersion: 1,
  createdAt: '2026-10-12T12:00:00Z',
  updatedAt: '2026-10-12T12:00:00Z',
};
const credentials = { token: 'key', subscriptionKey: 'subscription' };
const fetch = vi.fn<typeof globalThis.fetch>(async () =>
  Response.json({
    succeeded: true,
    page_number: 1,
    total_pages: 0,
    total_records: 0,
    data: { orders: [] },
  }),
);
describe('Starshipit release and grants', () => {
  it('default-off release prevents dispatch even when an installation exists', async () => {
    const provider = createStarshipitProvider({ simulation: () => fetch });
    await expect(
      provider.verify(connection, credentials),
    ).rejects.toMatchObject({
      failure: { code: 'unavailable', effect: 'none' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('an enabled read probe never invents live write permission', async () => {
    const provider = createStarshipitProvider({
      featureEnabled: async () => true,
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      expect(await provider.verify(connection, credentials)).toEqual([
        'orders.read',
        'fulfillment.read',
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
  it('synthetic write grants require the separate action release', async () => {
    const provider = createStarshipitProvider({
      simulation: () => fetch,
      featureEnabled: async (_tenant, flag) =>
        flag === 'starshipit-fulfillment',
    });
    expect(await provider.verify(connection, credentials)).toEqual([
      'orders.read',
      'fulfillment.read',
    ]);
    const released = createStarshipitProvider({
      simulation: () => fetch,
      featureEnabled: async () => true,
    });
    expect(await released.verify(connection, credentials)).toContain(
      'orders.quantity.update',
    );
  });
});
