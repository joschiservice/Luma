import { expect, it } from 'vitest';

import {
  summarizePurchaseOrderMetrics,
  summarizeStockMetrics,
} from './metrics.js';
import type { PurchaseOrder } from './procurement.js';

const asOf = '2026-09-28T00:00:00.000Z';
const rule = {
  id: 'rule',
  positionId: 'position',
  connectionId: 'source',
  supplierId: 'supplier',
  minimum: 10,
  target: 20,
  approvalQuantity: 100,
  sku: 'SKU',
  active: true,
};
const stock = {
  positionId: 'position',
  connectionId: 'source',
  sku: 'SKU',
  available: 9,
  unit: 'each',
  observedAt: asOf,
  deleted: false,
};
const order: PurchaseOrder = {
  id: 'order',
  tenantId: 'tenant',
  supplierId: 'different-supplier',
  supplierName: 'Supplier',
  authority: 'external',
  reference: 'PO-1',
  externalReferences: [],
  origin: {},
  lines: [
    { id: 'line', sku: 'SKU', description: 'Stock', quantity: 1, unit: 'each' },
    {
      id: 'line2',
      sku: 'SKU',
      description: 'Stock',
      quantity: 1,
      unit: 'each',
    },
  ],
  status: 'draft',
  revision: 1,
  createdAt: asOf,
  updatedAt: asOf,
};
it('uses exact source and threshold, covers absent stock and removes revoked rules', () => {
  expect(
    summarizeStockMetrics([rule], [{ ...stock, available: 10 }], [], asOf)[0],
  ).toMatchObject({ value: 0, total: 0, unknownCount: 0 });
  const missing = summarizeStockMetrics(
    [rule],
    [{ ...stock, connectionId: 'other' }],
    [],
    asOf,
  );
  expect(missing[0]).toMatchObject({ value: 0, total: null, unknownCount: 1 });
  expect(missing[1]).toMatchObject({
    value: 1,
    items: [{ reason: 'missing', ruleId: 'rule' }],
  });
  expect(
    summarizeStockMetrics([{ ...rule, active: false }], [stock], [], asOf)[0],
  ).toMatchObject({ population: 0, coverage: 'unavailable' });
});
it('expires exactly at five minutes without writes and reports unusable stock reasons', () => {
  const boundary = '2026-09-28T00:05:00.000Z';
  expect(summarizeStockMetrics([rule], [stock], [], asOf)[0]).toMatchObject({
    value: 1,
    nextRefreshAt: boundary,
  });
  expect(
    summarizeStockMetrics([rule], [stock], [], '2026-09-28T00:04:59.999Z')[0]
      ?.value,
  ).toBe(1);
  expect(
    summarizeStockMetrics([rule], [stock], [], boundary)[1]?.items[0]?.reason,
  ).toBe('expired');
  for (const [patch, reason] of [
    [{ deleted: true }, 'deleted'],
    [{ available: null }, 'nonnumeric'],
    [{ available: NaN }, 'nonnumeric'],
    [{ observedAt: boundary }, 'future'],
    [{ observedAt: 'bad' }, 'invalid_time'],
  ] as const) {
    expect(
      summarizeStockMetrics([rule], [{ ...stock, ...patch }], [], asOf)[1]
        ?.items[0]?.reason,
    ).toBe(reason);
  }
});
it('counts positions independently and links each commitment once across suppliers and sources', () => {
  const rules = [rule, { ...rule, id: 'rule2', positionId: 'position2' }];
  const stocks = [stock, { ...stock, positionId: 'position2' }];
  for (const status of ['draft', 'open', 'cancelled', 'closed'] as const) {
    const metrics = summarizeStockMetrics(
      rules,
      stocks,
      [{ ...order, status }],
      asOf,
    );
    const committed = ['draft', 'open'].includes(status);
    expect(metrics[0]?.value).toBe(2);
    expect(metrics[0]?.breakdown).toEqual([
      { reason: 'existing_commitment', count: committed ? 2 : 0 },
      { reason: 'no_commitment', count: committed ? 0 : 2 },
    ]);
    expect(metrics[0]?.items[0]?.commitmentIds).toEqual(
      committed ? ['order'] : [],
    );
    expect(
      summarizePurchaseOrderMetrics([{ ...order, status }], asOf).map(
        (m) => m.value,
      ),
    ).toEqual([status === 'draft' ? 1 : 0, status === 'open' ? 1 : 0]);
  }
});
