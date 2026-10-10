import type { InstalledConnection } from '@luma/connections';
import { createRequestPacer } from '@luma/connector-cin7';
import { expect, it, vi } from 'vitest';

import { createInstallationVerifier } from './verifier.js';

const connection: InstalledConnection = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  label: 'Cin7',
  target: {
    kind: 'cin7-core',
    accountId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  },
  permissions: ['orders.read', 'fulfillment.read', 'inventory.read'],
  granted: [],
  status: 'pending',
  version: 1,
  credentialVersion: 1,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
};

function verifier(fetch: typeof globalThis.fetch) {
  return createInstallationVerifier({
    fetch,
    pacer: () => createRequestPacer({ intervalMs: 0 }),
  });
}

it('grants requested capabilities whose endpoints answer', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = new URL(String(input)).pathname.split('/').pop();
    if (path === 'me') return Response.json({ Company: 'Demo' });
    if (path === 'saleList')
      return Response.json({ Total: 0, Page: 1, SaleList: [] });

    return new Response('', { status: 402 });
  });
  await expect(verifier(fetch)(connection, { token: 'key' })).resolves.toEqual([
    'orders.read',
    'fulfillment.read',
  ]);
  // Only requested capabilities are probed.
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('fails before granting anything when the key is rejected', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response('', { status: 403 }));
  await expect(verifier(fetch)(connection, { token: 'key' })).rejects.toThrow(
    'authentication',
  );
});
