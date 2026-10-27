import { describe, expect, it } from 'vitest';

import type { Commitment, FollowUp, Submission } from './commitments.js';
import {
  isMaterialChange,
  orderProgress,
  orderStage,
  reviewReasons,
} from './commitments.js';
import type { PurchaseOrder } from './procurement.js';

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
    { id: 'a', sku: 'TOTE', description: 'Tote', quantity: 100, unit: 'each' },
    { id: 'b', sku: 'BAG', description: 'Bag', quantity: 20, unit: 'each' },
  ],
  status: 'open',
  revision: 2,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
};

const submission = (patch: Partial<Submission> = {}): Submission => ({
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
  ...patch,
});

let next = 0;
const fact = (patch: Partial<Commitment>): Commitment => ({
  id: `c${++next}`,
  tenantId: 'tenant',
  purchaseOrderId: 'order',
  lineId: 'a',
  kind: 'confirmed_quantity',
  quantity: 100,
  date: null,
  text: null,
  source: {
    kind: 'purchasing_system',
    connectionId: 'connection',
    observationId: 'observation',
    observedAt: '2026-10-01T11:00:00.000Z',
    externalOrderId: '7',
  },
  status: 'confirmed',
  reviewReasons: [],
  supersedes: null,
  recordedAt: `2026-10-01T11:00:${String(next).padStart(2, '0')}.000Z`,
  recordedBy: { kind: 'luma', id: 'purchasing-system' },
  review: null,
  ...patch,
});

const progress = (input: {
  submission?: Submission | null;
  commitments?: Commitment[];
  followUps?: FollowUp[];
  now?: string;
  status?: PurchaseOrder['status'];
}) =>
  orderProgress({
    order: { ...order, status: input.status ?? 'open' },
    submission:
      input.submission === undefined ? submission() : input.submission,
    commitments: input.commitments ?? [],
    followUps: input.followUps ?? [],
    terms: { confirmationHours: 48 },
    draftVerified: false,
    supplierLinked: true,
    now: new Date(input.now ?? '2026-10-01T12:00:00.000Z'),
    timeZone: 'UTC',
  });

describe('supplier order progress', () => {
  it('keeps a draft, a sent order, a confirmation and a receipt apart', () => {
    const draft = progress({ submission: null, status: 'draft' });
    expect(draft.milestones.map((m) => m.state)).toEqual([
      'complete',
      'not_started',
      'not_started',
      'not_started',
    ]);
    expect(draft.expectedDate).toBeNull();
    expect(draft.next).toMatchObject({
      owner: 'buyer',
      title: 'Send the order to the supplier',
    });

    const sent = progress({});
    expect(sent.milestones.map((m) => m.state)).toEqual([
      'complete',
      'complete',
      'pending',
      'pending',
    ]);
    expect(sent.next.owner).toBe('supplier');
    expect(orderStage(order, submission(), sent)).toBe('awaiting_confirmation');

    const confirmed = progress({
      commitments: [
        fact({ lineId: 'a', quantity: 100 }),
        fact({ lineId: 'b', quantity: 20 }),
      ],
    });
    expect(confirmed.milestones[2]!.state).toBe('complete');
    expect(confirmed.next.owner).toBe('warehouse');
    expect(confirmed.lines.map((l) => l.received)).toEqual([0, 0]);
  });

  it('counts receipt only from purchasing-system evidence and tracks partial receipts', () => {
    const partial = progress({
      commitments: [
        fact({ lineId: 'a', quantity: 100 }),
        fact({ lineId: 'a', kind: 'received', quantity: 40 }),
        fact({ lineId: 'a', kind: 'received', quantity: 70 }),
      ],
    });
    expect(partial.lines[0]).toMatchObject({
      received: 70,
      outstanding: 30,
      stage: 'partially_received',
    });
    expect(partial.milestones[3]!.state).toBe('partial');

    const done = progress({
      commitments: [
        fact({ lineId: 'a', kind: 'received', quantity: 100 }),
        fact({ lineId: 'b', kind: 'received', quantity: 20 }),
      ],
    });
    expect(done.milestones[3]!.state).toBe('complete');
    expect(done.next.title).toBe('Close the order');
  });

  it('asks a person to accept changed quantities and later dates, once', () => {
    const changed = fact({ lineId: 'a', quantity: 60 });
    const later = fact({
      lineId: null,
      kind: 'promised_date',
      quantity: null,
      date: '2026-10-14',
    });
    const state = progress({ commitments: [changed, later] });
    expect(state.attention.map((a) => a.kind)).toEqual([
      'commitment_changed',
      'commitment_changed',
    ]);
    expect(state.lines[0]).toMatchObject({
      stage: 'changed',
      outstanding: 60,
      expectedDate: '2026-10-14',
    });

    const accepted = progress({
      commitments: [changed, later],
      followUps: state.attention.map((a, i) => ({
        id: `f${i}`,
        tenantId: 'tenant',
        purchaseOrderId: 'order',
        key: a.key,
        response: 'accepted' as const,
        note: 'ok',
        nextCheckAt: null,
        respondedBy: 'buyer',
        respondedAt: '2026-10-01T12:00:00.000Z',
      })),
    });
    expect(accepted.attention).toEqual([]);
  });

  it('raises missed confirmation and delivery deadlines, and a follow-up moves them', () => {
    const silent = progress({ now: '2026-10-03T11:00:00.000Z' });
    const overdue = silent.attention.find(
      (a) => a.kind === 'confirmation_overdue',
    );
    expect(overdue).toBeDefined();
    const followed = progress({
      now: '2026-10-03T11:00:00.000Z',
      followUps: [
        {
          id: 'f',
          tenantId: 'tenant',
          purchaseOrderId: 'order',
          key: overdue!.key,
          response: 'following_up',
          note: 'Called supplier',
          nextCheckAt: '2026-10-04T09:00:00.000Z',
          respondedBy: 'buyer',
          respondedAt: '2026-10-03T11:00:00.000Z',
        },
      ],
    });
    expect(
      followed.attention.some((a) => a.kind === 'confirmation_overdue'),
    ).toBe(false);

    const late = progress({
      now: '2026-10-12T08:00:00.000Z',
      commitments: [
        fact({ lineId: 'a', quantity: 100 }),
        fact({ lineId: 'b', quantity: 20 }),
      ],
    });
    expect(
      late.attention.filter((a) => a.kind === 'delivery_overdue'),
    ).toHaveLength(2);
    expect(late.milestones[3]!.state).toBe('attention');
  });

  it('shows uncertain sends and approvals as attention for the right owner', () => {
    expect(
      progress({
        submission: submission({
          state: 'approval_required',
          submittedAt: null,
        }),
      }).next.owner,
    ).toBe('approver');
    expect(
      progress({
        submission: submission({ state: 'uncertain', submittedAt: null }),
      }).next.owner,
    ).toBe('luma');
  });
});

describe('commitment review rules', () => {
  const line = order.lines[0]!;

  it('lets matching confident facts count and holds changes and ambiguity for review', () => {
    expect(
      reviewReasons(
        { kind: 'confirmed_quantity', quantity: 100, date: null, lineId: 'a' },
        line,
        '2026-10-10',
        {
          confident: true,
          lineRequired: true,
        },
      ),
    ).toEqual([]);
    expect(
      reviewReasons(
        { kind: 'confirmed_quantity', quantity: 80, date: null, lineId: 'a' },
        line,
        null,
        {
          confident: false,
          lineRequired: true,
        },
      ),
    ).toEqual(['low_confidence', 'quantity_changed']);
    expect(
      reviewReasons(
        {
          kind: 'promised_date',
          quantity: null,
          date: '2026-10-12',
          lineId: null,
        },
        null,
        '2026-10-10',
        {
          confident: true,
          lineRequired: false,
        },
      ),
    ).toEqual(['date_later']);
    expect(
      reviewReasons(
        { kind: 'confirmed_quantity', quantity: 5, date: null, lineId: null },
        null,
        null,
        {
          confident: true,
          lineRequired: true,
        },
      ),
    ).toContain('unmatched_line');
  });

  it('holds every fact from an unauthenticated sender for review', () => {
    expect(
      reviewReasons(
        { kind: 'confirmed_quantity', quantity: 100, date: null, lineId: 'a' },
        line,
        '2026-10-10',
        { confident: true, lineRequired: true, senderVerified: false },
      ),
    ).toEqual(['sender_unverified']);
    expect(
      reviewReasons(
        { kind: 'confirmed_quantity', quantity: 100, date: null, lineId: 'a' },
        line,
        '2026-10-10',
        { confident: true, lineRequired: true, senderVerified: true },
      ),
    ).toEqual([]);
  });

  it('treats only confirmed differences as material', () => {
    expect(isMaterialChange(fact({ quantity: 90 }), line, null)).toBe(true);
    expect(
      isMaterialChange(
        fact({ quantity: 90, status: 'needs_review' }),
        line,
        null,
      ),
    ).toBe(false);
    expect(
      isMaterialChange(
        fact({ kind: 'promised_date', quantity: null, date: '2026-10-09' }),
        line,
        '2026-10-10',
      ),
    ).toBe(false);
  });
});

it('reconciles a partial manual receipt while damaged units need a decision', () => {
  const receipt = fact({
    kind: 'received',
    quantity: 40,
    source: {
      kind: 'manual_receipt',
      receivedAt: '2026-10-01T11:00:00.000Z',
      condition: 'mixed',
      reason: 'Delivery note DN-1',
      evidence: ['photo:broken-carton'],
    },
  });
  const damage = fact({ kind: 'damaged', quantity: 2, source: receipt.source });
  const state = progress({ commitments: [receipt, damage] });
  expect(state.lines[0]).toMatchObject({
    ordered: 100,
    received: 40,
    damaged: 2,
    goodReceived: 38,
    outstanding: 60,
  });
  expect(state.attention).toContainEqual(
    expect.objectContaining({
      kind: 'receipt_difference',
      commitmentId: damage.id,
    }),
  );
  const writtenOff = progress({
    commitments: [receipt, damage],
    followUps: [
      {
        id: 'decision',
        tenantId: 'tenant',
        purchaseOrderId: 'order',
        key: `receipt_difference:${damage.id}`,
        response: 'written_off',
        note: 'Supplier declined replacement',
        nextCheckAt: null,
        respondedBy: 'buyer',
        respondedAt: '2026-10-01T12:00:00.000Z',
      },
    ],
  });
  expect(
    writtenOff.attention.some((item) => item.kind === 'receipt_difference'),
  ).toBe(false);
  expect(writtenOff.lines[0]?.goodReceived).toBe(38);
});

it('returns a changed commitment after a wait, then respects a final decision', () => {
  const changed = fact({ quantity: 60 });
  const key = `commitment_changed:${changed.id}`;
  const wait: FollowUp = {
    id: 'wait',
    tenantId: 'tenant',
    purchaseOrderId: 'order',
    key,
    response: 'following_up',
    note: 'Waiting for the remainder',
    nextCheckAt: '2026-10-04T09:00:00.000Z',
    respondedBy: 'buyer',
    respondedAt: '2026-10-01T12:00:00.000Z',
  };
  expect(
    progress({
      commitments: [changed],
      followUps: [wait],
      now: '2026-10-03T12:00:00.000Z',
    }).attention.some((item) => item.kind === 'commitment_changed'),
  ).toBe(false);
  const returned = progress({
    commitments: [changed],
    followUps: [wait],
    now: '2026-10-04T10:00:00.000Z',
  });
  expect(returned.attention).toContainEqual(
    expect.objectContaining({ key: `${key}:${wait.nextCheckAt}` }),
  );
  const accepted: FollowUp = {
    ...wait,
    id: 'accept',
    key: `${key}:${wait.nextCheckAt}`,
    response: 'accepted',
    note: 'Accept lower quantity',
    nextCheckAt: null,
  };
  expect(
    progress({
      commitments: [changed],
      followUps: [wait, accepted],
      now: '2026-10-04T10:00:00.000Z',
    }).attention.some((item) => item.kind === 'commitment_changed'),
  ).toBe(false);
});

it('reports the earliest check of items still being followed up', () => {
  const changed = fact({ quantity: 60 });
  const follow = (
    id: string,
    key: string,
    nextCheckAt: string | null,
    response: FollowUp['response'] = 'following_up',
  ): FollowUp => ({
    id,
    tenantId: 'tenant',
    purchaseOrderId: 'order',
    key,
    response,
    note: 'Called the supplier',
    nextCheckAt,
    respondedBy: 'buyer',
    respondedAt: '2026-10-01T12:00:00.000Z',
  });
  const base = `commitment_changed:${changed.id}`;
  expect(progress({ commitments: [changed] }).nextCheckAt).toBeNull();
  const waiting = progress({
    commitments: [changed],
    followUps: [follow('wait', base, '2026-10-04T11:00:00+02:00')],
    now: '2026-10-03T12:00:00.000Z',
  });
  expect(waiting.nextCheckAt).toBe('2026-10-04T09:00:00.000Z');
  // A passed check stays reported while the item is back in attention.
  const due = progress({
    commitments: [changed],
    followUps: [follow('wait', base, '2026-10-04T09:00:00.000Z')],
    now: '2026-10-05T12:00:00.000Z',
  });
  expect(due.nextCheckAt).toBe('2026-10-04T09:00:00.000Z');
  expect(due.attention.some((a) => a.kind === 'commitment_changed')).toBe(true);
  // A later check of a rescheduled item, and none once the item is settled.
  expect(
    progress({
      commitments: [changed],
      followUps: [
        follow('wait', base, '2026-10-04T09:00:00.000Z'),
        follow(
          'again',
          `${base}:2026-10-04T09:00:00.000Z`,
          '2026-10-08T09:00:00.000Z',
        ),
      ],
    }).nextCheckAt,
  ).toBe('2026-10-08T09:00:00.000Z');
  expect(
    progress({
      commitments: [changed],
      followUps: [
        follow('wait', base, '2026-10-04T09:00:00.000Z'),
        follow('accept', `${base}:2026-10-04T09:00:00.000Z`, null, 'accepted'),
      ],
    }).nextCheckAt,
  ).toBeNull();
  // The earliest of several: a missed confirmation followed up sooner.
  const silent = progress({ now: '2026-10-03T11:00:00.000Z' });
  const overdue = silent.attention.find(
    (a) => a.kind === 'confirmation_overdue',
  )!;
  expect(
    progress({
      now: '2026-10-03T11:00:00.000Z',
      followUps: [follow('chase', overdue.key, '2026-10-03T15:00:00.000Z')],
    }).nextCheckAt,
  ).toBe('2026-10-03T15:00:00.000Z');
});

it('removes credited shortages from expected arrivals and preserves receipt evidence', () => {
  const receipt = fact({ kind: 'received', quantity: 40 });
  const shortage = fact({ kind: 'shortage', quantity: 60 });
  const state = progress({
    commitments: [receipt, shortage],
    followUps: [
      {
        id: 'credit',
        tenantId: 'tenant',
        purchaseOrderId: 'order',
        key: `receipt_difference:${shortage.id}`,
        response: 'credited',
        note: 'Credit note CN-7',
        nextCheckAt: null,
        respondedBy: 'buyer',
        respondedAt: '2026-10-01T12:00:00.000Z',
      },
    ],
  });
  expect(state.lines[0]).toMatchObject({
    ordered: 100,
    received: 40,
    outstanding: 0,
    goodReceived: 40,
    stage: 'received',
  });
});
