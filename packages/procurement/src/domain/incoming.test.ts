import { describe, expect, it } from 'vitest';

import { type Commitment, type Submission } from './commitments.js';
import { arrivalStatus, supplierIncoming } from './incoming.js';
import type { PurchaseOrder } from './procurement.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const order: PurchaseOrder = {
  id: 'order',
  tenantId: 'tenant',
  supplierId: 'supplier',
  supplierName: 'Supplier',
  reference: 'PO-1',
  authority: 'luma',
  externalReferences: [],
  origin: {},
  status: 'open',
  revision: 2,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  lines: [
    {
      id: 'line',
      sku: 'TOTE',
      description: 'Tote',
      quantity: 100,
      unit: 'each',
      locationId: 'location',
    },
  ],
};
const submission: Submission = {
  id: 'submission',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  connectionId: 'connection',
  supplier: { externalId: 'supplier', scopeKey: '' },
  lines: [],
  actionId: 'action',
  decisionId: null,
  requestedBy: 'buyer',
  requestedAt: now.toISOString(),
  expiresAt: now.toISOString(),
  state: 'submitted',
  externalOrder: { externalId: 'external', orderNumber: 'EXT' },
  requestedDeliveryDate: '2026-10-14',
  submittedAt: now.toISOString(),
  decidedBy: null,
  decidedAt: null,
  failure: null,
  updatedAt: now.toISOString(),
};

function fact(
  kind: Commitment['kind'],
  quantity: number | null,
  date: string | null = null,
): Commitment {
  return {
    id: kind,
    tenantId: 'tenant',
    purchaseOrderId: 'order',
    lineId: 'line',
    kind,
    quantity,
    date,
    text: null,
    source: {
      kind: 'purchasing_system',
      connectionId: 'connection',
      observationId: 'observation',
      observedAt: now.toISOString(),
      externalOrderId: 'external',
    },
    status: 'confirmed',
    reviewReasons: [],
    supersedes: null,
    recordedAt: now.toISOString(),
    recordedBy: { kind: 'user', id: 'buyer' },
    review: null,
  };
}

function incoming(
  commitments: Commitment[] = [],
  patch: Partial<Parameters<typeof supplierIncoming>[0]> = {},
) {
  return supplierIncoming({
    order,
    submission,
    commitments,
    followUps: [],
    aliases: new Map([['TOTE', 'sku']]),
    locations: new Map([['location', 'Warehouse']]),
    ownedLocations: new Set(),
    now,
    ...patch,
  });
}

describe('incoming supplier stock', () => {
  it('keeps the confirmed remainder and new arrival date after a partial receipt', () => {
    const result = incoming([
      fact('confirmed_quantity', 80),
      fact('received', 40),
      fact('promised_date', null, '2026-10-16'),
    ]);
    expect(result).toMatchObject([
      {
        quantity: 40,
        expectedDate: '2026-10-16',
        dateStatus: 'confirmed',
        locationId: 'location',
        source: 'purchase_order',
      },
    ]);
  });
  it('excludes cancelled and fully received orders', () => {
    expect(incoming([], { order: { ...order, status: 'cancelled' } })).toEqual(
      [],
    );
    expect(incoming([fact('received', 100)])).toEqual([]);
  });
  it('replaces supplier arrivals with the owned ledger rather than counting both', () => {
    expect(incoming([], { ownedLocations: new Set(['location']) })).toEqual([]);
  });
  it('marks past supplier dates as overdue and keeps stale evidence visible', () => {
    const result = incoming([fact('promised_date', null, '2026-10-10')], {
      now: new Date('2026-10-15T12:00:00Z'),
    });
    expect(result).toMatchObject([
      { dateStatus: 'overdue', freshness: 'stale' },
    ]);
    expect(arrivalStatus('2026-10-12T10:00:00Z', now)).toBe('overdue');
  });
  it('does not count a supplier credit as still incoming', () => {
    const shortage = fact('shortage', 20);
    expect(
      incoming(
        [fact('confirmed_quantity', 80), fact('received', 60), shortage],
        {
          followUps: [
            {
              id: 'response',
              tenantId: 'tenant',
              purchaseOrderId: 'order',
              key: 'receipt_difference:shortage',
              response: 'credited',
              note: 'Supplier credited remainder',
              nextCheckAt: null,
              respondedBy: 'buyer',
              respondedAt: now.toISOString(),
            },
          ],
        },
      ),
    ).toEqual([]);
  });
  it('does not count a purchase-order link to the same location transfer as another supplier arrival', () => {
    expect(
      incoming([], {
        order: {
          ...order,
          externalReferences: [
            {
              system: 'shopify_inventory_transfer',
              externalId: 'gid://shopify/InventoryTransfer/1',
            },
          ],
        },
      }),
    ).toEqual([]);
  });
  it('never invents a product mapping', () => {
    expect(incoming([], { aliases: new Map() })).toEqual([]);
  });
});
