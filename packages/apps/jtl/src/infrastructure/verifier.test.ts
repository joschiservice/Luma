import type { InstalledConnection } from '@luma/connections';
import { describe, expect, it, vi } from 'vitest';

import { createInstallationVerifier } from './verifier.js';

const empty = { items: [], totalItems: 0, pageNumber: 1, pageSize: 1 };

const purchasing: InstalledConnection = {
  id: 'connection',
  tenantId: 'tenant',
  label: 'ERP',
  target: {
    kind: 'jtl-cloud',
    jtlTenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  },
  permissions: [
    'suppliers.read',
    'purchase-orders.read',
    'purchase-orders.submit',
  ],
  granted: [],
  status: 'pending',
  version: 1,
  credentialVersion: 1,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const credentials = { token: 'private-token' };

const denying = (denied: string[]) =>
  vi.fn<typeof globalThis.fetch>(async (url) =>
    denied.some((path) => new URL(String(url)).pathname.endsWith(`/${path}`))
      ? new Response(null, { status: 403 })
      : Response.json(empty),
  );

describe('JTL purchasing grants', () => {
  it('grants supplier and purchase-order reads from read probes, never submission', async () => {
    const fetch = denying([]);
    const granted = await createInstallationVerifier({
      fetch,
      jtlEndpoints: [],
    })(purchasing, credentials);
    expect(granted).toEqual(['suppliers.read', 'purchase-orders.read']);
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(['/erp/v2/suppliers', '/erp/v2/purchase-orders']);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
      true,
    );
  });

  it('omits denied reads', async () => {
    const granted = await createInstallationVerifier({
      fetch: denying(['suppliers']),
      jtlEndpoints: [],
    })(purchasing, credentials);
    expect(granted).toEqual(['purchase-orders.read']);
  });

  it.each([
    [[], ['suppliers.read', 'purchase-orders.read', 'purchase-orders.submit']],
    [['items'], ['suppliers.read', 'purchase-orders.read']],
    [['purchase-orders'], ['suppliers.read']],
  ])(
    'grants simulated submission only with purchase-order and item reads (denied %j)',
    async (denied, expected) => {
      const fetch = denying(denied);
      const granted = await createInstallationVerifier({
        simulation: () => fetch,
        jtlEndpoints: [],
      })({ ...purchasing, label: 'SIMULATED ERP' }, credentials);
      expect(granted).toEqual(expected);
      expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
        true,
      );
    },
  );

  it('does not grant simulated submission unless requested', async () => {
    const granted = await createInstallationVerifier({
      simulation: () => denying([]),
      jtlEndpoints: [],
    })(
      {
        ...purchasing,
        label: 'SIMULATED ERP',
        permissions: ['purchase-orders.read'],
      },
      credentials,
    );
    expect(granted).toEqual(['purchase-orders.read']);
  });
});
