import { describe, expect, it } from 'vitest';

import { describeActionDiff } from './action-diff.js';

const intent = {
  tenantId: 'tenant',
  connectionId: 'provider',
  capability: 'inventory.available.reconcile',
  target: { kind: 'position', id: 'stock' },
  parameters: {
    expectedAvailable: 15,
    available: 12,
    locationId: 'warehouse',
    expectedRevision: 'r2',
  },
  expectedPostcondition: { available: 12 },
  preconditions: {
    evidenceRefs: ['observation'],
    validUntil: '2026-10-13T12:00:00Z',
  },
};

describe('immutable action diffs', () => {
  it('shows a stock correction with its expected value and exact target/location scope', () => {
    const diff = describeActionDiff(intent, '2026-10-13T11:55:00Z')!;
    expect(diff.records[0]?.changes[0]).toEqual({
      field: 'available',
      before: 15,
      beforeKnown: true,
      after: 12,
      afterKnown: true,
      expected: 15,
      expectedKnown: true,
    });
    expect(diff.scope).toEqual([
      { kind: 'position', count: 1, ids: ['stock'] },
      { kind: 'location', count: 1, ids: ['warehouse'] },
      { kind: 'listing', count: null, ids: [] },
    ]);
    expect(diff.evidence.observedAt).toBe('2026-10-13T11:55:00Z');
    expect(diff.canonicalOutcome).toBe('requires_fresh_verification');
  });

  it('does not turn an expected revision into a known status or invent observation time', () => {
    const diff = describeActionDiff({
      ...intent,
      capability: 'orders.write',
      parameters: { expectedRevision: 'r2' },
      expectedPostcondition: { status: 'cancelled' },
    })!;
    expect(diff.records[0]?.changes[0]).toMatchObject({
      before: null,
      beforeKnown: false,
      expectedKnown: false,
      after: 'cancelled',
    });
    expect(diff.records[0]?.changes[1]).toMatchObject({
      field: 'revision',
      afterKnown: false,
      expected: 'r2',
    });
    expect(diff.evidence.observedAt).toBeNull();
    expect(diff.reversibility).toBe('irreversible');
  });

  it('distinguishes internal draft preparation from external supplier commitment', () => {
    const draft = describeActionDiff({
      ...intent,
      connectionId: intent.tenantId,
      capability: 'procurement.purchase-order.create',
      parameters: { supplierId: 'supplier' },
      expectedPostcondition: { status: 'draft' },
    })!;
    expect(draft.records[0]?.system).toBe('luma');
    expect(draft.canonicalOutcome).toBe('internal_record');
    expect(
      describeActionDiff({ ...intent, capability: 'purchase-orders.submit' })
        ?.reversibility,
    ).toBe('irreversible');
  });

  it('keeps known null distinct from a missing baseline and rejects unreviewed capabilities', () => {
    const diff = describeActionDiff({
      ...intent,
      capability: 'adaptive.order.field.write',
      parameters: { expectedValueJson: null },
      expectedPostcondition: { valueJson: '"new"' },
    })!;
    expect(diff.records[0]?.changes[0]).toMatchObject({
      before: null,
      beforeKnown: true,
    });
    expect(
      describeActionDiff({ ...intent, capability: 'new.unreviewed.write' }),
    ).toBeNull();
  });
});

it('reviews installed Shopify and Starshipit line encodings without treating a request ID as an order ID', () => {
  const shopify = describeActionDiff({
    ...intent,
    capability: 'orders.quantity.edit',
    target: { kind: 'shopify_order_edit', id: 'request' },
    parameters: {
      orderId: 'gid://shopify/Order/55',
      lines: '1:15>12,2:4>0',
      restock: true,
      expectedRevision: 'r1',
    },
    expectedPostcondition: { lineQuantities: '1:12,2:0' },
  })!;
  expect(shopify.records[0]).toMatchObject({
    kind: 'order',
    id: 'gid://shopify/Order/55',
  });
  expect(shopify.records[0]?.changes).toContainEqual({
    field: 'lines[gid://shopify/LineItem/1].quantity',
    before: 15,
    beforeKnown: true,
    after: 12,
    afterKnown: true,
    expected: 15,
    expectedKnown: true,
  });
  expect(shopify.scope).toContainEqual({
    kind: 'order_line',
    count: 2,
    ids: ['gid://shopify/LineItem/1', 'gid://shopify/LineItem/2'],
  });
  const starshipit = describeActionDiff({
    ...intent,
    capability: 'orders.quantity.update',
    target: { kind: 'starshipit_order_update', id: 'request' },
    parameters: {
      orderId: '44',
      lines: JSON.stringify([{ id: 'line', currentQuantity: 7, quantity: 3 }]),
    },
    expectedPostcondition: {
      lineQuantities: JSON.stringify([{ id: 'line', quantity: 3 }]),
    },
  })!;
  expect(starshipit.records[0]).toMatchObject({ kind: 'order', id: '44' });
  expect(starshipit.records[0]?.changes[0]).toMatchObject({
    before: 7,
    after: 3,
    expected: 7,
    expectedKnown: true,
  });
});

it('uses an owned frozen fulfillment baseline and exposes a draft’s complete known line scope', () => {
  const moved = describeActionDiff(
    {
      ...intent,
      capability: 'fulfillment.move',
      target: { kind: 'shopify_fulfillment', id: 'request' },
      parameters: {
        orderId: 'order',
        fulfillmentOrderId: 'fulfillment',
        locationId: 'next',
        expectedRevision: 'r1',
      },
      expectedPostcondition: { fulfillmentProgress: true },
    },
    null,
    { locationId: 'before' },
  )!;
  expect(moved.records[0]).toMatchObject({
    kind: 'fulfillment_order',
    id: 'fulfillment',
  });
  expect(
    moved.records[0]?.changes.find((change) => change.field === 'locationId'),
  ).toMatchObject({
    before: 'before',
    after: 'next',
    expected: 'before',
    expectedKnown: true,
  });
  const draft = describeActionDiff({
    ...intent,
    connectionId: intent.tenantId,
    capability: 'procurement.purchase-order.create',
    parameters: {
      supplierId: 'supplier',
      lines: JSON.stringify([{ id: 'line-1', skuId: 'sku-1', quantity: 12 }]),
    },
    expectedPostcondition: { status: 'draft' },
  })!;
  expect(
    draft.records[0]?.changes.find(
      (change) => change.field === 'lines[line-1].quantity',
    ),
  ).toMatchObject({ after: 12, beforeKnown: false });
  expect(draft.scope).toContainEqual({
    kind: 'order_line',
    count: 1,
    ids: ['line-1'],
  });
});

it('keeps newly created provider identities unknown and honors the adaptive stored before JSON key', () => {
  const submission = describeActionDiff({
    ...intent,
    capability: 'purchase-orders.submit',
    target: { kind: 'purchase_order_submission', id: 'request' },
    parameters: { purchaseOrderId: 'canonical-order' },
    expectedPostcondition: { lines: 2 },
  })!;
  expect(submission.records[0]).toMatchObject({
    kind: 'purchase_order',
    id: null,
  });
  expect(submission.scope).toContainEqual({
    kind: 'purchase_order',
    count: 1,
    ids: ['canonical-order'],
  });
  const custom = describeActionDiff({
    ...intent,
    connectionId: intent.tenantId,
    capability: 'adaptive.order.field.write',
    parameters: {
      beforeValueJson: '"before"',
      valueJson: '"after"',
      revision: 2,
    },
    expectedPostcondition: { valueJson: '"after"' },
  })!;
  expect(custom.records[0]?.changes[0]).toMatchObject({
    before: '"before"',
    after: '"after"',
    expectedKnown: true,
  });
});

it('reviews owner-frozen settlement and exchange plans without fabricating balances or created IDs', () => {
  const refund = describeActionDiff(
    {
      ...intent,
      capability: 'returns.refund',
      target: { kind: 'return_case_settlement', id: 'internal-operation' },
      parameters: { planDigest: 'immutable-digest' },
      expectedPostcondition: {
        operationId: 'internal-operation',
        kind: 'refund',
      },
    },
    '2026-10-13T11:55:00Z',
    {
      plan: {
        kind: 'refund',
        order: { externalId: 'provider-order' },
        lines: [{ orderLine: { externalId: 'provider-line' }, quantity: 2 }],
        amount: '14.00',
        currency: 'EUR',
      },
    },
  )!;
  expect(refund.records[0]?.id).toBeNull();
  expect(refund.records[0]?.changes).toContainEqual({
    field: 'amount',
    before: null,
    beforeKnown: false,
    after: '14.00',
    afterKnown: true,
    expected: null,
    expectedKnown: false,
  });
  expect(refund.scope).toContainEqual({
    kind: 'order_line',
    count: 1,
    ids: ['provider-line'],
  });
  const restock = describeActionDiff(
    {
      ...intent,
      capability: 'returns.restock',
      target: { kind: 'return_case_settlement', id: 'internal-operation' },
      parameters: {},
      expectedPostcondition: { kind: 'restock' },
    },
    null,
    {
      plan: {
        kind: 'restock',
        item: { externalId: 'item' },
        warehouse: { externalId: 'warehouse' },
        quantity: 2,
        baselineOnHand: '8',
      },
    },
  )!;
  expect(restock.records[0]?.changes).toContainEqual({
    field: 'onHand',
    before: '8',
    beforeKnown: true,
    after: null,
    afterKnown: false,
    expected: '8',
    expectedKnown: true,
  });
  expect(restock.scope).toContainEqual({
    kind: 'location',
    count: 1,
    ids: ['warehouse'],
  });
  const note = describeActionDiff({
    ...intent,
    connectionId: intent.tenantId,
    capability: 'procurement.follow-up.record',
    target: { kind: 'purchase_order', id: 'order' },
    parameters: { nextCheckAt: '2026-10-13T16:00:00Z' },
    expectedPostcondition: { recorded: true },
  })!;
  expect(note.records[0]?.system).toBe('luma');
  expect(note.canonicalOutcome).toBe('internal_record');
});

it('keeps a new provider shipment unknown while identifying its affected existing order', () => {
  const diff = describeActionDiff({
    ...intent,
    capability: 'fulfillment.shipment.create',
    target: { kind: 'shopify_shipment_publication', id: 'request' },
    parameters: { orderId: 'gid://shopify/Order/44' },
    expectedPostcondition: { trackingNumber: 'TRACK-1' },
  })!;
  expect(diff.records[0]).toMatchObject({ kind: 'fulfillment', id: null });
  expect(diff.scope).toContainEqual({
    kind: 'order',
    count: 1,
    ids: ['gid://shopify/Order/44'],
  });
  expect(diff.scope).toContainEqual({ kind: 'customer', count: null, ids: [] });
});

it('admits the purchasing owner submission encoding to review without requiring a created provider order', () => {
  const diff = describeActionDiff({
    ...intent,
    capability: 'purchase-orders.submit',
    target: { kind: 'purchase_order_submission', id: 'submission' },
    parameters: {
      purchaseOrderId: 'canonical-order',
      reference: 'PO-GOVERNED-1',
      supplierId: '1',
      supplierScope: '',
      requestedDeliveryDate: '2026-10-20',
      lines: JSON.stringify([
        {
          lineId: 'canonical-line',
          sku: { externalId: '2', scopeKey: '' },
          quantity: 10,
          unit: 'each',
        },
      ]),
    },
    expectedPostcondition: { lumaOrderId: 'canonical-order', lines: 1 },
  });
  expect(diff).toMatchObject({
    reversibility: 'irreversible',
    records: [{ system: 'provider', kind: 'purchase_order', id: null }],
  });
  expect(diff?.records[0]?.changes).toContainEqual({
    field: 'lines[canonical-line].quantity',
    before: null,
    beforeKnown: false,
    after: 10,
    afterKnown: true,
    expected: null,
    expectedKnown: false,
  });
});
