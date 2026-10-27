import { describe, expect, it } from 'vitest';

import { createCommitmentContext } from '../application/commitment-context.js';
import {
  type FollowUp,
  type Submission,
  workspaceDay,
} from '../domain/commitments.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { commitmentFixture } from './commitments.fixture.js';

const order: PurchaseOrder = {
  id: 'order',
  tenantId: 'tenant',
  supplierId: 'supplier',
  supplierName: 'Nordwind',
  reference: 'PO-1',
  authority: 'luma',
  externalReferences: [],
  origin: {},
  lines: [
    { id: 'a', sku: 'TOTE', description: 'Tote', quantity: 10, unit: 'each' },
  ],
  status: 'open',
  revision: 2,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const submission: Submission = {
  id: 'submission',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  connectionId: 'connection',
  supplier: { externalId: '1', scopeKey: '' },
  requestedDeliveryDate: '2026-10-10',
  lines: [],
  actionId: 'action',
  decisionId: 'decision',
  requestedBy: 'buyer',
  requestedAt: '2026-10-01T09:00:00.000Z',
  expiresAt: '2026-10-02T09:00:00.000Z',
  state: 'submitted',
  externalOrder: { externalId: '7', orderNumber: 'BE-7' },
  submittedAt: '2026-10-01T10:00:00.000Z',
  decidedBy: 'approver',
  decidedAt: '2026-10-01T09:30:00.000Z',
  failure: null,
  updatedAt: '2026-10-01T10:00:00.000Z',
};

/** Whether the order's only line is overdue at `now` in a workspace in `timeZone`. */
function overdue(now: string, timeZone: string, followUps: FollowUp[] = []) {
  const { progressFor } = createCommitmentContext(commitmentFixture().deps);
  const { progress } = progressFor(order, {
    submissions: [submission],
    commitments: [],
    followUps,
    supplier: null,
    verified: new Set(),
    now: new Date(now),
    timeZone,
  });

  return {
    line: progress.lines[0]!.overdue,
    attention: progress.attention.some((a) => a.kind === 'delivery_overdue'),
    keys: progress.attention
      .filter((a) => a.kind === 'delivery_overdue')
      .map((a) => a.key),
  };
}

/** A person's follow-up on the overdue delivery that moves its check to `nextCheckAt`. */
const followUp = (nextCheckAt: string): FollowUp => ({
  id: 'follow-up',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  key: 'delivery_overdue:order:a:2026-10-10',
  response: 'following_up',
  note: 'Called the supplier',
  nextCheckAt,
  respondedBy: 'buyer',
  respondedAt: '2026-10-11T08:00:00.000Z',
});

describe('overdue deliveries in the workspace time zone', () => {
  it('keeps a delivery due today on time in a UTC-5 workspace after UTC midnight', () => {
    // 23:30 on 10 October in Bogotá, 04:30 on 11 October in UTC.
    expect(overdue('2026-10-11T04:30:00.000Z', 'America/Bogota')).toMatchObject(
      {
        line: false,
        attention: false,
      },
    );
    // 00:30 on 11 October in Bogotá.
    expect(overdue('2026-10-11T05:30:00.000Z', 'America/Bogota')).toMatchObject(
      {
        line: true,
        attention: true,
      },
    );
  });

  it('marks a delivery overdue in a UTC+2 workspace before UTC midnight', () => {
    // 23:30 on 10 October in Johannesburg.
    expect(
      overdue('2026-10-10T21:30:00.000Z', 'Africa/Johannesburg'),
    ).toMatchObject({
      line: false,
      attention: false,
    });
    // 00:30 on 11 October in Johannesburg, still 10 October in UTC.
    expect(
      overdue('2026-10-10T22:30:00.000Z', 'Africa/Johannesburg'),
    ).toMatchObject({
      line: true,
      attention: true,
    });
  });

  it('moves a follow-up check to the workspace day of its check time', () => {
    // The check at 01:30 on 12 October in Johannesburg (23:30 on 11 October in UTC) is due
    // on 12 October, so the item returns at 00:30 on 13 October under that day's key.
    expect(
      overdue('2026-10-12T22:30:00.000Z', 'Africa/Johannesburg', [
        followUp('2026-10-11T23:30:00.000Z'),
      ]).keys,
    ).toEqual(['delivery_overdue:order:a:2026-10-10:2026-10-12']);
  });

  it('accepts today’s delivery date in a UTC-5 workspace after UTC midnight', async () => {
    const fixture = commitmentFixture();
    fixture.timeZone('America/Bogota');
    // 22:00 on 10 October in Bogotá. The date passes; this fixture cannot send orders.
    fixture.now('2026-10-11T03:00:00.000Z');
    await expect(
      fixture.service.requestSubmission(fixture.context(), fixture.order.id, {
        id: '6f1d9b4e-3c2a-4b8e-9f10-2a3b4c5d6e7f',
        requestedDeliveryDate: '2026-10-10',
      }),
    ).rejects.toThrow('Sending orders is unavailable on this server.');
  });

  it('refuses yesterday’s delivery date in a UTC+2 workspace before UTC midnight', async () => {
    const fixture = commitmentFixture();
    fixture.timeZone('Africa/Johannesburg');
    // 00:30 on 11 October in Johannesburg, still 10 October in UTC.
    fixture.now('2026-10-10T22:30:00.000Z');
    await expect(
      fixture.service.requestSubmission(fixture.context(), fixture.order.id, {
        id: '6f1d9b4e-3c2a-4b8e-9f10-2a3b4c5d6e7f',
        requestedDeliveryDate: '2026-10-10',
      }),
    ).rejects.toThrow('Choose a delivery date that is today or later.');
  });

  it('falls back to the UTC day for a zone the runtime does not know', () => {
    expect(
      workspaceDay(new Date('2026-10-10T22:30:00.000Z'), 'Mars/Base'),
    ).toBe('2026-10-10');
  });
});
