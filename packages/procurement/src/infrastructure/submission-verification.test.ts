import { randomUUID } from 'node:crypto';

import type { WriteAcceptance } from '@luma/connections';
import { describe, expect, it } from 'vitest';

import type { PurchasingOrder } from '../application/commitments.js';
import type { Submission } from '../domain/commitments.js';
import { commitmentFixture } from './commitments.fixture.js';

const requestedAt = '2026-10-02T11:00:00.000Z',
  observedAt = '2026-10-02T11:30:00.000Z';

function fixture() {
  const f = commitmentFixture();
  const connectionId = randomUUID();
  const submission: Submission = {
    id: randomUUID(),
    tenantId: f.order.tenantId,
    purchaseOrderId: f.order.id,
    connectionId,
    supplier: { externalId: '10', scopeKey: 'global' },
    requestedDeliveryDate: '2026-10-20',
    lines: [
      {
        lineId: f.order.lines[0]!.id,
        sku: { externalId: '1', scopeKey: 'global' },
        quantity: 100,
        unit: 'each',
      },
    ],
    actionId: randomUUID(),
    decisionId: randomUUID(),
    requestedBy: 'buyer',
    requestedAt,
    expiresAt: '2026-10-03T11:00:00.000Z',
    state: 'submitting',
    externalOrder: null,
    submittedAt: null,
    decidedBy: 'approver',
    decidedAt: requestedAt,
    failure: null,
    updatedAt: requestedAt,
  };
  f.submissions.push(submission);
  const read = (overrides: Partial<PurchasingOrder> = {}): PurchasingOrder => ({
    observationId: randomUUID(),
    observedAt,
    provider: 'jtl',
    adapterVersion: 'jtl-wawi/2.2',
    sourceUpdatedAt: null,
    sourceRevision: null,
    completeness: 'complete',
    externalId: '50',
    scopeKey: 'global',
    data: {
      supplier: submission.supplier,
      orderNumber: 'PO-50',
      lumaOrderId: f.order.id,
      status: 'open',
      requestedDeliveryDate: '2026-10-20',
      confirmed: false,
      createdAt: observedAt,
      lines: [
        {
          id: { externalId: '500', scopeKey: '50' },
          sku: { externalId: '1', scopeKey: 'global' },
          itemNumber: 'SKU-1',
          quantity: { amount: '100', unit: 'each' },
          deliveredQuantity: '0',
          confirmedQuantity: null,
          confirmedDeliveryDate: null,
          confirmed: false,
          requestedDeliveryDate: '2026-10-20',
        },
      ],
    },
    ...overrides,
  });
  let result:
    { ok: true; value: PurchasingOrder[] } | { ok: false; reason: string } = {
    ok: true,
    value: [],
  };
  f.deps.purchasing = {
    connections: async () => [],
    suppliers: async () => ({
      ok: true,
      value: { items: [], nextCursor: null },
    }),
    orders: async () => structuredClone(result),
  };

  return {
    ...f,
    connectionId,
    submission,
    read,
    respond: (value: typeof result) => {
      result = value;
    },
    verify: () => f.service.verify(f.context(), submission.id),
  };
}

describe('submission verification evidence', () => {
  it('stores the read it cites with source identity, freshness and completeness', async () => {
    const f = fixture();
    const found = f.read();
    f.respond({ ok: true, value: [found] });

    const result = await f.verify();

    expect(result).toEqual({
      outcome: 'passed',
      observationRefs: [found.observationId],
      observedAt,
    });
    expect(f.reads.get(found.observationId)).toEqual({
      id: found.observationId,
      tenantId: f.order.tenantId,
      purchaseOrderId: f.order.id,
      purpose: 'submission',
      subjectId: f.submission.id,
      source: {
        provider: 'jtl',
        connectionId: f.connectionId,
        resource: 'purchase_order',
        externalId: '50',
        scopeKey: 'global',
      },
      observedAt,
      sourceUpdatedAt: null,
      sourceRevision: null,
      adapterVersion: 'jtl-wawi/2.2',
      completeness: 'complete',
      data: found.data,
    });
  });

  it('cites and stores every duplicate it finds, and never passes a partial read', async () => {
    const f = fixture();
    const duplicates = [f.read(), f.read({ externalId: '51' })];
    f.respond({ ok: true, value: duplicates });
    const failed = await f.verify();
    expect(failed.outcome).toBe('failed');
    expect(failed.observationRefs).toEqual(
      duplicates.map((d) => d.observationId),
    );

    const partial = f.read({ completeness: 'partial' });
    f.respond({ ok: true, value: [partial] });
    const inconclusive = await f.verify();
    expect(inconclusive.outcome).toBe('inconclusive');
    expect(inconclusive.observationRefs).toEqual([partial.observationId]);

    for (const ref of [
      ...failed.observationRefs,
      ...inconclusive.observationRefs,
    ])
      expect(f.reads.get(ref)?.subjectId).toBe(f.submission.id);
    expect(f.reads.get(partial.observationId)?.completeness).toBe('partial');
  });

  it('cites nothing when the read fails or finds no order', async () => {
    const f = fixture();
    f.respond({ ok: false, reason: 'unavailable' });
    expect(await f.verify()).toMatchObject({
      outcome: 'inconclusive',
      observationRefs: [],
    });
    f.respond({
      ok: true,
      value: [
        f.read({ data: { ...f.read().data, lumaOrderId: randomUUID() } }),
      ],
    });
    expect(await f.verify()).toMatchObject({
      outcome: 'inconclusive',
      observationRefs: [],
    });
    expect(f.reads.size).toBe(0);
  });
});

describe('submission write receipts', () => {
  const acceptance = (connectionId: string): WriteAcceptance => ({
    provider: 'jtl',
    connectionId,
    capability: 'purchase-orders.submit',
    adapterVersion: 'jtl-wawi/2.2',
    dispatchIdentity: '["jtl","jtl-wawi/2.2"]',
    idempotencyKey: 'v0:submission-action',
    acceptedAt: observedAt,
    providerRequestId: 'jtl-request-1',
    records: [{ resource: 'purchase_order', externalId: '50' }],
  });

  it('stores the accepted submission under the ID execution cites', async () => {
    const f = fixture();
    const id = await f.service.storeWriteReceipt(
      f.context(),
      f.submission.id,
      acceptance(f.connectionId),
    );
    expect([...f.receipts.values()]).toEqual([
      {
        kind: 'write_receipt',
        id,
        tenantId: f.order.tenantId,
        purchaseOrderId: f.order.id,
        purpose: 'submission',
        subjectId: f.submission.id,
        source: { provider: 'jtl', connectionId: f.connectionId },
        capability: 'purchase-orders.submit',
        adapterVersion: 'jtl-wawi/2.2',
        dispatchIdentity: '["jtl","jtl-wawi/2.2"]',
        idempotencyKey: 'v0:submission-action',
        observedAt,
        status: 'accepted',
        providerRequestId: 'jtl-request-1',
        records: [{ resource: 'purchase_order', externalId: '50' }],
      },
    ]);
  });

  it('refuses an acceptance from another connection or capability', async () => {
    const f = fixture();
    for (const value of [
      acceptance(randomUUID()),
      {
        ...acceptance(f.connectionId),
        capability: 'purchase-orders.revise' as const,
      },
    ])
      await expect(
        f.service.storeWriteReceipt(f.context(), f.submission.id, value),
      ).rejects.toThrow('The receipt does not belong to this submission.');
    expect(f.receipts.size).toBe(0);
  });
});
