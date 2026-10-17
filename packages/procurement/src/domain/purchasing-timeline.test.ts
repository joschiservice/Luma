import { describe, expect, it } from 'vitest';

import type { Commitment, Submission } from './commitments.js';
import type { PurchaseOrder } from './procurement.js';
import {
  purchasingExecutionVerified,
  purchasingTimeline,
  type PurchasingTimelineEntry,
  restrictStockBookings,
} from './purchasing-timeline.js';

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
const manual: Commitment = {
  id: 'manual',
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  orderRevision: 2,
  lineId: 'line',
  kind: 'received',
  quantity: 8,
  date: null,
  text: null,
  source: {
    kind: 'manual_receipt',
    receivedAt: at,
    condition: 'mixed',
    reason: 'Signed delivery note',
    evidence: ['delivery-note'],
  },
  status: 'confirmed',
  reviewReasons: [],
  supersedes: null,
  recordedAt: at,
  recordedBy: { kind: 'user', id: 'warehouse' },
  review: null,
};
const input = {
  order,
  history: [],
  submissions: [],
  communications: [],
  commitments: [],
  followUps: [],
  extra: [],
} satisfies Parameters<typeof purchasingTimeline>[0];
const proof: PurchasingTimelineEntry = {
  id: 'stock-proof',
  kind: 'stock_booking',
  stage: 'verified',
  at,
  actorId: null,
  source: 'inventory',
  reason: null,
  evidenceRefs: ['independent-stock-read'],
  quantity: 6,
  unit: 'each',
  revision: null,
  detail: null,
};

it('keeps manual receipts, supplier observations and stock proof separate while preserving revisions and people', () => {
  const observed: Commitment = {
    ...manual,
    id: 'provider-receipt',
    source: {
      kind: 'purchasing_system',
      connectionId: 'connection',
      observationId: 'provider-read',
      observedAt: at,
      externalOrderId: '1',
    },
    recordedBy: { kind: 'luma', id: 'luma' },
  };
  const timeline = purchasingTimeline({
    ...input,
    commitments: [manual, observed],
    extra: [proof],
  });
  expect(
    timeline.entries.find((e) => e.id === 'commitment:manual'),
  ).toMatchObject({
    stage: 'recorded',
    source: 'manual',
    actorId: 'warehouse',
    reason: 'Signed delivery note',
    revision: 2,
    evidenceRefs: ['delivery-note'],
  });
  expect(
    timeline.entries.find((e) => e.id === 'commitment:provider-receipt'),
  ).toMatchObject({
    stage: 'observed',
    source: 'purchasing_system',
    evidenceRefs: ['provider-read'],
  });
  expect(timeline.entries.filter((e) => e.stage === 'verified')).toEqual([
    proof,
  ]);
});

it('labels an outgoing email as sent and never turns it into purchasing or stock verification', () => {
  const timeline = purchasingTimeline({
    ...input,
    submissions: [
      {
        ...submission,
        channel: 'email',
        outgoing: {
          outboundId: 'outbound',
          threadId: 'thread',
          sentMessageId: 'mail-id',
        },
        externalOrder: null,
      },
    ],
  });
  expect(timeline.entries.find((e) => e.stage === 'sent')).toMatchObject({
    source: 'email',
    evidenceRefs: ['mail-id'],
  });
  expect(timeline.entries.some((e) => e.stage === 'verified')).toBe(false);
});

it('keeps the authoritative admission proof once, orders events consistently and bounds long histories explicitly', () => {
  const nativeProof = {
    ...proof,
    id: 'submission:submission:verified',
    kind: 'submission' as const,
    source: 'purchasing_system' as const,
    evidenceRefs: ['actual-order-read'],
  };
  const timeline = purchasingTimeline({
    ...input,
    submissions: [submission],
    extra: [nativeProof],
  });
  expect(timeline.entries.filter((e) => e.stage === 'verified')).toEqual([
    nativeProof,
  ]);
  const many = Array.from({ length: 501 }, (_, i) => ({
    ...proof,
    id: String(i),
    at: new Date(Date.parse(at) + i * 1000).toISOString(),
  }));
  const bounded = purchasingTimeline({ ...input, extra: many });
  expect(bounded.complete).toBe(false);
  expect(bounded.entries).toHaveLength(500);
  expect(bounded.entries[0]!.id).toBe('1');
});

it('requires a satisfied result, passed independent verification and concrete evidence before marking stock verified', () => {
  expect(
    purchasingExecutionVerified({
      businessOutcome: 'satisfied',
      verification: { outcome: 'passed', observationRefs: ['fresh-read'] },
    }),
  ).toBe(true);
  expect(
    purchasingExecutionVerified({
      businessOutcome: 'satisfied',
      verification: {
        outcome: 'inconclusive',
        observationRefs: ['accepted-write'],
      },
    }),
  ).toBe(false);
  expect(
    purchasingExecutionVerified({
      businessOutcome: 'satisfied',
      verification: { outcome: 'passed', observationRefs: [] },
    }),
  ).toBe(false);
  expect(
    purchasingExecutionVerified({
      businessOutcome: 'inconclusive',
      verification: { outcome: 'passed', observationRefs: ['read'] },
    }),
  ).toBe(false);
});

it('preserves before and after lifecycle states in the purchasing evidence timeline', () => {
  const result = purchasingTimeline({
    ...input,
    history: [
      {
        id: 'opened',
        occurredAt: at,
        actorId: 'buyer',
        reason: 'Order sent',
        revision: 2,
        from: 'draft',
        to: 'open',
      },
    ],
  });
  expect(result.entries[0]).toMatchObject({
    kind: 'lifecycle',
    detail: 'draft->open',
    actorId: 'buyer',
    reason: 'Order sent',
    revision: 2,
  });
});

describe('stock bookings for a reader without inventory access', () => {
  const step = (
    entry: Pick<PurchasingTimelineEntry, 'id' | 'stage' | 'source'> &
      Partial<PurchasingTimelineEntry>,
  ): PurchasingTimelineEntry => ({
    kind: 'stock_booking',
    at,
    actorId: 'inventory-lead',
    actor: {
      kind: 'member',
      id: 'inventory-lead',
      name: 'Ines Lager',
      email: 'ines@example.test',
      workflow: { id: 'run', name: 'Receipt booking' },
    },
    reason: 'Book received units at Berlin',
    evidenceRefs: ['booking'],
    quantity: 19,
    unit: 'pcs',
    revision: 3,
    detail: 'location:berlin sku:LUMA-001 gid://shopify/InventoryLevel/1',
    ...entry,
  });
  const bookings = [
    step({
      id: 'stock:booking:requested',
      stage: 'recorded',
      source: 'inventory',
    }),
    step({
      id: 'policy:decision',
      stage: 'approval_required',
      source: 'luma',
      evidenceRefs: ['decision', 'booking'],
    }),
    step({
      id: 'approval:approval',
      stage: 'approved',
      source: 'luma',
      evidenceRefs: ['approval', 'decision', 'booking'],
    }),
    step({
      id: 'execution:attempt',
      stage: 'verified',
      source: 'inventory',
      evidenceRefs: ['read', 'receipt'],
    }),
  ];
  const receipt: PurchasingTimelineEntry = {
    id: 'commitment:received',
    kind: 'commitment',
    stage: 'recorded',
    at,
    actorId: 'buyer',
    reason: 'Delivery note',
    evidenceRefs: ['note'],
    quantity: 20,
    unit: 'pcs',
    revision: 2,
    detail: 'received',
    source: 'manual',
  };

  it('keeps each step, its stage, time, source and evidence, naming the permission', () => {
    expect(restrictStockBookings([...bookings, receipt], false)).toEqual([
      ...bookings.map((entry) => ({
        id: entry.id,
        kind: 'stock_booking',
        stage: entry.stage,
        at,
        actorId: null,
        reason: null,
        evidenceRefs: entry.evidenceRefs,
        quantity: null,
        unit: null,
        revision: null,
        detail: null,
        source: entry.source,
        restricted: { permission: 'inventory.read' },
      })),
      receipt,
    ]);
  });

  it('strips quantities, locations, provider IDs, actors and approvers', () => {
    const shown = JSON.stringify(restrictStockBookings(bookings, false));
    for (const hidden of [
      'inventory-lead',
      'Ines Lager',
      'ines@example.test',
      'Receipt booking',
      'Berlin',
      'berlin',
      'LUMA-001',
      'gid://',
      'pcs',
      '19',
    ])
      expect(shown).not.toContain(hidden);
    expect(
      restrictStockBookings(bookings, false).every(
        (entry) => entry.actor === undefined,
      ),
    ).toBe(true);
  });

  it('leaves the timeline unchanged for inventory readers', () => {
    const entries = [...bookings, receipt];
    expect(restrictStockBookings(entries, true)).toBe(entries);
  });
});
