import { describe, expect, it } from 'vitest';

import { summarizeConnectionCoverage } from '#modules/connectors/domain/coverage';
import type { InstalledConnection } from '#modules/connectors/domain/installation';

const asOf = '2026-09-20T12:00:00.000Z';

const connection: InstalledConnection = {
  id: 'connection',
  tenantId: 'tenant',
  label: 'Store',
  target: { kind: 'shopify', shop: 'example.myshopify.com' },
  permissions: ['orders.read', 'inventory.read'],
  granted: ['orders.read', 'inventory.read'],
  status: 'degraded',
  version: 1,
  credentialVersion: 1,
  createdAt: asOf,
  updatedAt: asOf,
};

describe('connection coverage', () => {
  it('reports no observations as unobserved', () => {
    expect(summarizeConnectionCoverage(connection, [], asOf)).toEqual({
      id: connection.id,
      label: connection.label,
      status: 'degraded',
      lastObservedAt: null,
      freshness: 'unobserved',
    });
  });

  it('keeps the latest observation when another read is missing', () => {
    expect(
      summarizeConnectionCoverage(
        connection,
        [{ capability: 'orders.read', observedAt: asOf }],
        asOf,
      ),
    ).toMatchObject({ lastObservedAt: asOf, freshness: 'unobserved' });
  });

  it.each([
    ['2026-09-19T12:00:00.000Z', 'fresh'],
    ['2026-09-19T11:59:59.999Z', 'stale'],
  ])('classifies the oldest read at %s as %s', (observedAt, freshness) => {
    expect(
      summarizeConnectionCoverage(
        connection,
        [
          { capability: 'orders.read', observedAt: asOf },
          { capability: 'inventory.read', observedAt },
        ],
        asOf,
      ),
    ).toMatchObject({ lastObservedAt: asOf, freshness });
  });

  it('ignores writes, ungranted reads, and reads without permission', () => {
    expect(
      summarizeConnectionCoverage(
        {
          ...connection,
          granted: [
            'orders.read',
            'products.read',
            'orders.shipping-method.write',
          ],
          permissions: [
            'orders.read',
            'inventory.read',
            'orders.shipping-method.write',
          ],
        },
        [
          { capability: 'orders.read', observedAt: '2026-09-20T11:00:00.000Z' },
          { capability: 'products.read', observedAt: asOf },
          { capability: 'inventory.read', observedAt: asOf },
          { capability: 'orders.shipping-method.write', observedAt: asOf },
        ],
        asOf,
      ),
    ).toMatchObject({
      lastObservedAt: '2026-09-20T11:00:00.000Z',
      freshness: 'fresh',
    });
  });

  it.each([
    { granted: [], permissions: connection.permissions },
    { granted: connection.granted, permissions: [] },
    {
      granted: ['orders.shipping-method.write'],
      permissions: ['orders.shipping-method.write'],
    },
  ] satisfies Pick<InstalledConnection, 'granted' | 'permissions'>[])(
    'reports no permitted granted reads as unobserved: %j',
    (capabilities) => {
      expect(
        summarizeConnectionCoverage(
          { ...connection, ...capabilities },
          [{ capability: 'orders.read', observedAt: asOf }],
          asOf,
        ),
      ).toMatchObject({ lastObservedAt: null, freshness: 'unobserved' });
    },
  );
});
