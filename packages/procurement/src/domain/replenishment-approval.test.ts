import { describe, expect, it } from 'vitest';

import type { PurchaseOrder } from './procurement.js';
import { replenishmentApprovalCoversSend } from './replenishment-approval.js';

const now = Date.parse('2026-10-14T05:00:00Z');
const destination = {
  connectionId: 'jtl',
  externalId: 'supplier-7',
  scopeKey: '',
};
const order: PurchaseOrder = {
  id: 'order',
  tenantId: 'tenant',
  supplierId: 'supplier',
  supplierName: 'Northstar',
  reference: 'REP-1',
  authority: 'luma',
  externalReferences: [],
  origin: { workflowRunId: 'run', actionId: 'draft' },
  lines: [
    {
      id: 'line',
      sku: 'TOTE',
      description: 'Tote',
      quantity: 100,
      unit: 'each',
      unitPrice: { amount: '49.999999', currency: 'AUD' },
    },
  ],
  status: 'draft',
  revision: 1,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
const input = () => ({
  order: structuredClone(order),
  draft: {
    capability: 'procurement.purchase-order.create',
    target: { id: order.id },
    parameters: {
      supplierId: order.supplierId,
      reference: order.reference,
      lines: JSON.stringify(order.lines),
      submissionScope: JSON.stringify(destination),
    },
  },
  grant: {
    requesterId: 'requester',
    expiresAt: new Date(now + 60000).toISOString(),
  },
  actorId: 'requester',
  connectionId: destination.connectionId,
  supplierId: destination.externalId,
  supplierScope: '',
  destination,
  rule: {
    separateSend: false,
    threshold: { amount: '5000', currency: 'AUD' } as {
      amount: string;
      currency: string;
    } | null,
  },
  now,
});

describe('replenishment approval coverage', () => {
  it('covers only an unchanged draft below the exact value threshold', () => {
    expect(replenishmentApprovalCoversSend(input())).toBe(true);
    const boundary = input();
    boundary.order.lines[0]!.unitPrice!.amount = '50';
    boundary.draft.parameters.lines = JSON.stringify(boundary.order.lines);
    expect(replenishmentApprovalCoversSend(boundary)).toBe(false);
  });
  it.each([
    'revision',
    'quantity',
    'supplier',
    'destination',
    'requester',
    'expiry',
    'invalid_expiry',
    'separate',
    'currency',
    'unknown_price',
    'missing_scope',
    'manual',
  ])('requires a new review for %s', (change) => {
    const value = input();
    switch (change) {
      case 'revision':
        value.order.revision = 2;
        break;
      case 'quantity':
        value.order.lines[0]!.quantity++;
        break;
      case 'supplier':
        value.order.supplierId = 'other';
        break;
      case 'destination':
        value.connectionId = 'other';
        break;
      case 'requester':
        value.actorId = 'other';
        break;
      case 'invalid_expiry':
        value.grant.expiresAt = 'not-recorded';
        break;
      case 'expiry':
        value.grant.expiresAt = new Date(now).toISOString();
        break;
      case 'separate':
        value.rule.separateSend = true;
        break;
      case 'currency':
        value.rule.threshold!.currency = 'EUR';
        break;
      case 'unknown_price':
        delete value.order.lines[0]!.unitPrice;
        value.draft.parameters.lines = JSON.stringify(value.order.lines);
        break;
      case 'missing_scope':
        value.draft.parameters.submissionScope = 'null';
        break;
      case 'manual':
        delete value.order.origin.workflowRunId;
        break;
    }
    expect(replenishmentApprovalCoversSend(value)).toBe(false);
  });
});
