import type {
  ReturnDetail,
  ReturnList,
  ReturnListItem,
  ReturnSource,
} from '@luma/api-contract';

export const store = '11111111-1111-4111-8111-111111111111';

export const erp = '22222222-2222-4222-8222-222222222222';

const asOf = '2026-09-30T09:00:00.000Z';

export const sources: ReturnSource[] = [
  {
    connectionId: store,
    label: 'Tokyo store',
    system: 'shopify',
    appId: 'shopify',
    status: 'active',
    access: 'granted',
    records: 6,
    importing: false,
    fullReadAt: '2026-09-30T02:00:00.000Z',
    lastReadAt: '2026-09-30T08:55:00.000Z',
    failing: false,
  },
  {
    connectionId: erp,
    label: 'JTL-Wawi',
    system: 'jtl',
    appId: 'jtl',
    status: 'active',
    access: 'not_requested',
    records: 0,
    importing: false,
    fullReadAt: null,
    lastReadAt: null,
    failing: false,
  },
];

const noRefund: ReturnListItem['refund'] = {
  state: 'none',
  currency: 'EUR',
  refunded: null,
  pending: null,
  failedAttempts: 0,
};

/** Builds a list item; the defaults describe an approved return waiting for its items. */
export function returnItem(
  overrides: Partial<ReturnListItem> = {},
): ReturnListItem {
  return {
    id: '33333333-3333-4333-8333-333333333301',
    kind: 'return',
    connectionId: store,
    externalId: 'gid://shopify/Return/9001',
    name: '#1001-R1',
    order: {
      id: '44444444-4444-4444-8444-444444444401',
      displayNumber: '#1001',
    },
    status: 'open',
    stage: 'awaiting_items',
    group: 'waiting',
    refund: noRefund,
    quantity: '2',
    received: '1',
    refundedUnits: '0',
    value: { amount: '48', currency: 'EUR' },
    reasons: ['Size too small'],
    requestedAt: '2026-09-24T09:00:00.000Z',
    activityAt: '2026-09-27T14:00:00.000Z',
    observedAt: '2026-09-30T08:55:00.000Z',
    sourceUpdatedAt: null,
    deleted: false,
    ...overrides,
  };
}

const id = (n: number) =>
  `33333333-3333-4333-8333-3333333333${String(n).padStart(2, '0')}`;

export const items: ReturnListItem[] = [
  returnItem({
    id: id(2),
    name: '#1004-R1',
    order: {
      id: '44444444-4444-4444-8444-444444444404',
      displayNumber: '#1004',
    },
    status: 'requested',
    stage: 'requested',
    group: 'action',
    received: '0',
    reasons: ['Wrong item'],
    requestedAt: '2026-09-29T07:30:00.000Z',
    activityAt: '2026-09-29T07:30:00.000Z',
  }),
  returnItem({
    id: id(3),
    name: '#1003-R1',
    order: {
      id: '44444444-4444-4444-8444-444444444403',
      displayNumber: '#1003',
    },
    stage: 'awaiting_refund',
    group: 'action',
    quantity: '1',
    received: '1',
    reasons: ['Defective'],
    value: { amount: '24', currency: 'EUR' },
    requestedAt: '2026-09-20T12:00:00.000Z',
  }),
  returnItem({
    id: id(4),
    name: '#1002-R1',
    order: {
      id: '44444444-4444-4444-8444-444444444402',
      displayNumber: '#1002',
    },
    stage: 'refund_failed',
    group: 'action',
    received: '2',
    refund: { ...noRefund, state: 'failed', failedAttempts: 1 },
    reasons: ['Changed mind', 'Style'],
    requestedAt: '2026-09-18T08:00:00.000Z',
  }),
  returnItem(),
  returnItem({
    id: id(5),
    name: '#0998-R1',
    order: {
      id: '44444444-4444-4444-8444-444444444398',
      displayNumber: '#998',
    },
    stage: 'refund_pending',
    group: 'waiting',
    received: '2',
    refundedUnits: '2',
    refund: { ...noRefund, state: 'pending', pending: '48' },
    requestedAt: '2026-09-15T08:00:00.000Z',
  }),
];

export const list: ReturnList = {
  items,
  sources,
  counts: {
    views: { action: 3, waiting: 2, done: 7, all: 12 },
    stages: {
      requested: 1,
      awaiting_items: 1,
      awaiting_refund: 1,
      refund_pending: 1,
      refund_failed: 1,
      closed: 6,
      declined: 1,
    },
  },
  nextCursor: null,
  asOf,
};

/** A return with one failed and one pending refund payment, partly received. */
export const detail: ReturnDetail = {
  item: returnItem({
    stage: 'refund_pending',
    group: 'waiting',
    received: '2',
    refundedUnits: '2',
    refund: {
      state: 'pending',
      currency: 'EUR',
      refunded: null,
      pending: '48',
      failedAttempts: 1,
    },
    activityAt: '2026-09-29T10:00:00.000Z',
  }),
  source: sources[0]!,
  order: {
    id: '44444444-4444-4444-8444-444444444401',
    displayNumber: '#1001',
    externalId: 'gid://shopify/Order/1001',
    status: 'completed',
    paymentStatus: 'paid',
    placedAt: '2026-09-18T08:00:00.000Z',
    total: { amount: '72', currency: 'EUR' },
  },
  lines: [
    {
      orderLineId: '55555555-5555-4555-8555-555555555501',
      title: 'Canvas tote',
      skuId: '66666666-6666-4666-8666-666666666601',
      skuCode: 'TOTE-RED',
      quantity: '2',
      unit: 'each',
      reason: 'Size too small',
      received: '2',
      restocked: '1',
      refunded: '2',
      value: { amount: '48', currency: 'EUR' },
    },
  ],
  timeline: {
    requestedAt: '2026-09-24T09:00:00.000Z',
    approvedAt: '2026-09-24T11:30:00.000Z',
    receivedAt: '2026-09-27T14:00:00.000Z',
    closedAt: null,
    declineReason: null,
  },
  refunds: [
    {
      id: '77777777-7777-4777-8777-777777777701',
      externalId: 'gid://shopify/Refund/801',
      createdAt: '2026-09-28T09:00:00.000Z',
      total: { amount: '0.00', currency: 'EUR' },
      lines: [
        {
          orderLineId: '55555555-5555-4555-8555-555555555501',
          title: 'Canvas tote',
          quantity: '2',
          unit: 'each',
          restock: 'return',
          restocked: true,
        },
      ],
      transactions: [
        {
          status: 'failed',
          amount: { amount: '48.00', currency: 'EUR' },
          processedAt: '2026-09-28T09:00:00.000Z',
          gateway: 'shopify_payments',
        },
      ],
      observedAt: '2026-09-30T08:55:00.000Z',
      sourceUpdatedAt: '2026-09-28T09:00:00.000Z',
    },
    {
      id: '77777777-7777-4777-8777-777777777702',
      externalId: 'gid://shopify/Refund/802',
      createdAt: '2026-09-29T10:00:00.000Z',
      total: { amount: '0.00', currency: 'EUR' },
      lines: [],
      transactions: [
        {
          status: 'pending',
          amount: { amount: '48.00', currency: 'EUR' },
          processedAt: null,
          gateway: 'shopify_payments',
        },
      ],
      observedAt: '2026-09-30T08:55:00.000Z',
      sourceUpdatedAt: '2026-09-29T10:00:00.000Z',
    },
  ],
  related: [],
  history: {
    entries: [
      {
        snapshotId: '88888888-8888-4888-8888-888888888801',
        entityKind: 'return',
        entityId: '33333333-3333-4333-8333-333333333301',
        status: 'open',
        current: true,
        deleted: false,
        observedAt: '2026-09-30T08:55:00.000Z',
        sourceUpdatedAt: null,
      },
      {
        snapshotId: '88888888-8888-4888-8888-888888888802',
        entityKind: 'return',
        entityId: '33333333-3333-4333-8333-333333333301',
        status: 'requested',
        current: false,
        deleted: false,
        observedAt: '2026-09-24T09:05:00.000Z',
        sourceUpdatedAt: null,
      },
    ],
    truncated: false,
  },
  asOf,
};
