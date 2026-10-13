import type { SourceRecords } from '@luma/connections';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import type { CommerceProjections } from '@luma/orders';
import { describe, expect, it } from 'vitest';

import { validateOrderLineIdentity } from './order-line-links.js';

type SourceMapping = Awaited<ReturnType<SourceRecords['mappings']>>[number];

type Projection = Awaited<ReturnType<CommerceProjections['current']>>[number];

const context = makeTenantContext(
  { userId: 'owner', sessionId: 'session' },
  {
    id: 'tenant',
    name: 'Test',
    slug: 'test',
    status: 'active',
    dataRegion: 'EU',
  },
  builtInMembership(
    { id: 'member', organizationId: 'tenant', userId: 'owner' },
    'owner',
  ),
  'request',
);
const mapping = (connectionId: string, canonicalId: string): SourceMapping => ({
  source: {
    tenantId: 'tenant',
    connectionId,
    provider: 'provider',
    resource: 'order_line',
    externalId: canonicalId,
    scopeKey: 'external-order',
  },
  canonicalId,
  method: 'Explicit confirmation',
  actorId: 'owner',
  createdAt: '2026-10-01T00:00:00Z',
  revisedAt: null,
  revisionId: null,
  previousCanonicalId: null,
});
const projection = (
  connectionId: string,
  id: string,
  unit: string,
  quantity = '1',
): Projection => ({
  snapshotId: `${connectionId}-snapshot`,
  version: 1,
  snapshot: {
    schemaVersion: 7,
    entityId: 'parent',
    kind: 'order',
    connectionId,
    observationId: `${connectionId}-observation`,
    normalizerVersion: 'test',
    mappingVersion: 'test',
    sourceRevision: null,
    sourceUpdatedAt: null,
    observedAt: '2026-10-01T00:00:00Z',
    deleted: false,
    data: {
      type: 'order',
      displayNumber: null,
      status: 'open',
      paymentStatus: 'unknown',
      lines: [
        {
          id,
          skuId: null,
          quantity,
          currentQuantity: quantity,
          cancelledQuantity: null,
          unit,
        },
      ],
    },
  },
});

function ports(
  projections = [
    projection('shop', 'left', 'each'),
    projection('shipping', 'right', 'each'),
  ],
  otherParent: string | null = 'parent',
): Pick<CommerceProjections, 'childParent' | 'current'> {
  return {
    childParent: async (_context, id) =>
      id === 'left' ? 'parent' : otherParent,
    current: async () => projections,
  };
}

const check = (orders = ports()) =>
  validateOrderLineIdentity(
    orders,
    context,
    'left',
    'right',
    [mapping('shop', 'left')],
    [mapping('shipping', 'right')],
  );

describe('explicit order line confirmation', () => {
  it('allows different quantities only when exact current lines share a linked parent and unit', async () => {
    await expect(
      check(
        ports([
          projection('shop', 'left', 'each', '1'),
          projection('shipping', 'right', 'each', '3'),
        ]),
      ),
    ).resolves.toBe('parent');
  });
  it.each([null, 'different-parent'])(
    'rejects a parent that was not explicitly linked: %s',
    async (parent) => {
      await expect(check(ports(undefined, parent))).rejects.toThrow(
        'Link the parent orders',
      );
    },
  );
  it('rejects unit conversion, even when the same item description could match', async () => {
    await expect(
      check(
        ports([
          projection('shop', 'left', 'each'),
          projection('shipping', 'right', 'case'),
        ]),
      ),
    ).rejects.toThrow('same units');
  });
  it('rejects historical, deleted or repeated lines instead of guessing a current match', async () => {
    await expect(
      check(ports([projection('shop', 'left', 'each')])),
    ).rejects.toThrow('current order lines');
    const deleted = projection('shipping', 'right', 'each');
    deleted.snapshot.deleted = true;
    await expect(
      check(ports([projection('shop', 'left', 'each'), deleted])),
    ).rejects.toThrow('current order lines');
    const repeated = projection('shipping', 'right', 'each');
    if (repeated.snapshot.data.type === 'order')
      repeated.snapshot.data.lines.push({
        id: 'right',
        skuId: null,
        quantity: '1',
        cancelledQuantity: null,
        unit: 'each',
      });
    await expect(
      check(ports([projection('shop', 'left', 'each'), repeated])),
    ).rejects.toThrow('current order lines');
  });
});
