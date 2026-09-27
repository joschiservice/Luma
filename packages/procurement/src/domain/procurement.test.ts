import { expect, it } from 'vitest';

import type { PurchaseOrderInput } from './procurement.js';
import { nextStatuses, purchaseOrderProblem } from './procurement.js';

it('keeps terminal and externally owned orders immutable', () => {
  expect(nextStatuses({ authority: 'luma', status: 'draft' })).toEqual([
    'open',
    'cancelled',
  ]);
  expect(nextStatuses({ authority: 'luma', status: 'open' })).toEqual([
    'closed',
    'cancelled',
  ]);
  for (const status of ['draft', 'open', 'closed', 'cancelled'] as const)
    expect(nextStatuses({ authority: 'external', status })).toEqual([]);
  for (const status of ['closed', 'cancelled'] as const)
    expect(nextStatuses({ authority: 'luma', status })).toEqual([]);
});
it('requires distinct line identities and an explicit external authority mapping', () => {
  const order: PurchaseOrderInput = {
    id: 'order',
    supplierId: 'supplier',
    reference: 'PO',
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [
      {
        id: 'line',
        sku: 'SKU',
        description: 'Item',
        quantity: 1,
        unit: 'each',
      },
    ],
  };
  expect(purchaseOrderProblem(order)).toBeNull();
  expect(
    purchaseOrderProblem({ ...order, lines: [...order.lines, ...order.lines] }),
  ).toMatch(/distinct/);
  expect(purchaseOrderProblem({ ...order, authority: 'external' })).toMatch(
    /external reference/,
  );
  expect(
    purchaseOrderProblem({
      ...order,
      authority: 'external',
      externalReferences: [{ system: 'JTL', externalId: 'PO-1' }],
    }),
  ).toBeNull();
});
