import { expect, it } from 'vitest';

import { followUpScopeFingerprint } from './follow-up-snapshot.js';
import type { PurchaseOrder } from './procurement.js';

const order: PurchaseOrder = {
  id: 'order',
  tenantId: 'tenant',
  supplierId: 'supplier',
  supplierName: 'Supplier',
  reference: 'PO-1',
  authority: 'luma',
  status: 'open',
  revision: 2,
  externalReferences: [],
  origin: {},
  createdAt: '2026-10-13T12:00:00Z',
  updatedAt: '2026-10-13T12:00:00Z',
  lines: [
    { id: 'line', sku: 'SKU', description: 'Item', quantity: 10, unit: 'each' },
  ],
};
it('pins owner revision and all supplier, destination, quantity, price and source inputs while preserving unknown values', () => {
  const original = followUpScopeFingerprint(order);
  expect(followUpScopeFingerprint({ ...order, reference: 'User label' })).toBe(
    original,
  );
  for (const changed of [
    { revision: 3 },
    { supplierId: 'different' },
    { externalReferences: [{ system: 'JTL', externalId: 'PO-2' }] },
    { lines: [{ ...order.lines[0]!, quantity: 11 }] },
    { lines: [{ ...order.lines[0]!, locationId: 'warehouse' }] },
    {
      lines: [
        { ...order.lines[0]!, unitPrice: { amount: '1', currency: 'EUR' } },
      ],
    },
  ])
    expect(followUpScopeFingerprint({ ...order, ...changed })).not.toBe(
      original,
    );
  expect(JSON.parse(original).lines[0]).toMatchObject({
    locationId: null,
    unitPrice: null,
    requestedDeliveryDate: null,
  });
});
