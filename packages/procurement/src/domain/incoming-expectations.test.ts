import { describe, expect, it } from 'vitest';

import type { Commitment, FollowUp, Submission } from './commitments.js';
import {
  incomingLineExpectations,
  incomingSubmissionSettled,
} from './incoming-expectations.js';
import type { PurchaseOrder } from './procurement.js';

const at = '2026-10-13T12:00:00.000Z';
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
  lines: [
    { id: 'line', sku: 'SKU', description: 'Item', quantity: 10, unit: 'each' },
  ],
  createdAt: at,
  updatedAt: at,
};
const submission: Submission = {
  id: 'submission',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  connectionId: 'connection',
  supplier: { externalId: '1', scopeKey: '' },
  requestedDeliveryDate: '2026-10-20',
  lines: [
    {
      lineId: 'line',
      sku: { externalId: '2', scopeKey: '' },
      quantity: 10,
      unit: 'each',
    },
  ],
  actionId: 'action',
  decisionId: 'decision',
  requestedBy: 'buyer',
  requestedAt: at,
  expiresAt: '2026-10-14T12:00:00.000Z',
  state: 'submitted',
  externalOrder: { externalId: '1', orderNumber: 'PO-1' },
  submittedAt: at,
  decidedBy: 'approver',
  decidedAt: at,
  failure: null,
  updatedAt: at,
};
const shortage: Commitment = {
  id: 'shortage',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  orderRevision: 2,
  lineId: 'line',
  kind: 'shortage',
  quantity: 4,
  date: null,
  text: null,
  source: {
    kind: 'manual_receipt',
    receivedAt: '2026-10-15T12:00:00.000Z',
    condition: 'mixed',
    reason: 'Short delivery',
    evidence: ['delivery-note'],
  },
  status: 'confirmed',
  reviewReasons: [],
  supersedes: null,
  recordedAt: '2026-10-15T12:00:00.000Z',
  recordedBy: { kind: 'user', id: 'warehouse' },
  review: null,
};
const credited: FollowUp = {
  id: 'credit',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  key: 'receipt_difference:shortage',
  response: 'credited',
  note: 'Credit note',
  nextCheckAt: null,
  respondedBy: 'buyer',
  respondedAt: '2026-10-16T12:00:00.000Z',
};
const now = new Date('2026-10-16T12:00:00.000Z');

describe('incomingSubmissionSettled', () => {
  it('needs independent proof for a submitted order', () => {
    expect(incomingSubmissionSettled(submission)).toBe(true);
    expect(
      incomingSubmissionSettled({ ...submission, externalOrder: null }),
    ).toBe(false);
  });

  it('settles final failures and leaves pending submissions open', () => {
    expect(incomingSubmissionSettled({ ...submission, state: 'failed' })).toBe(
      true,
    );
    expect(
      incomingSubmissionSettled({ ...submission, state: 'uncertain' }),
    ).toBe(false);
  });
});

describe('incomingLineExpectations', () => {
  it('expects the ordered quantity of a submitted, open order', () => {
    expect(
      incomingLineExpectations({
        order,
        submission,
        commitments: [],
        followUps: [],
        now,
      }).get('line'),
    ).toMatchObject({
      expectedQuantity: 10,
      providerReceivedQuantity: 0,
      observedAt: at,
    });
  });

  it('removes a settled shortage and dates the line by its latest fact', () => {
    const line = incomingLineExpectations({
      order,
      submission,
      commitments: [shortage],
      followUps: [credited],
      now,
    }).get('line');

    expect(line).toMatchObject({
      expectedQuantity: 6,
      observedAt: shortage.recordedAt,
    });
  });

  it('expects nothing once the order is no longer open', () => {
    expect(
      incomingLineExpectations({
        order: { ...order, status: 'cancelled' },
        submission,
        commitments: [],
        followUps: [],
        now,
      }).get('line')?.expectedQuantity,
    ).toBe(0);
  });
});
