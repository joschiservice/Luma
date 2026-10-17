import { randomUUID } from 'node:crypto';

import { PermissionSet } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
} from '@luma/identity/composition';
import { describe, expect, it } from 'vitest';

import { createPurchaseReceiptTimeline } from './purchase-receipt-timeline.js';

const tenantId = randomUUID();

function context(permissions: string[]) {
  const membership = builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId: 'reader' },
    'owner',
  );

  return makeTenantContext(
    { userId: 'reader', sessionId: randomUUID() },
    {
      id: tenantId,
      name: 'Shop',
      slug: 'shop',
      dataRegion: 'EU',
      status: 'active',
    },
    { ...membership, permissions: new PermissionSet(permissions) },
    randomUUID(),
  );
}

describe('purchase receipt timeline', () => {
  it('builds restricted rows from the stage query without calling the ledger for procurement-only readers', async () => {
    const asked: string[] = [];
    const ledger = () => {
      throw new Error('The ledger requires inventory access');
    };
    const timeline = createPurchaseReceiptTimeline(ledger, async (_, id) => {
      asked.push(id);

      return [
        {
          reviewId: 'review',
          state: 'approved',
          at: '2026-10-13T12:00:00.000Z',
          verification: {
            outcome: 'verified',
            observedAt: '2026-10-13T13:00:00.000Z',
          },
        },
      ];
    });

    const entries = await timeline(context(['procurement.read']), 'order');

    expect(asked).toEqual(['order']);
    expect(
      entries.map(({ id, stage, restricted }) => ({ id, stage, restricted })),
    ).toEqual([
      {
        id: 'native-receipt:review:review',
        stage: 'approved',
        restricted: { permission: 'inventory.read' },
      },
      {
        id: 'native-receipt:review:proof',
        stage: 'verified',
        restricted: { permission: 'inventory.read' },
      },
    ]);
  });

  it('reads full reviews from the ledger for inventory readers', async () => {
    const ledger = {
      purchaseReceiptReviews: async () => ({
        enabled: true,
        items: [],
        ownedLineIds: [],
      }),
      verifyPurchaseReceipt: async () => {
        throw new Error('No review to verify');
      },
    };
    const timeline = createPurchaseReceiptTimeline(
      () => ledger,
      async () => {
        throw new Error('Inventory readers get the full reviews');
      },
    );

    expect(
      await timeline(context(['procurement.read', 'inventory.read']), 'order'),
    ).toEqual([]);
  });
});
