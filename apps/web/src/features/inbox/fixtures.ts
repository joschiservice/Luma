import type {
  DocumentDetail,
  Fact,
  Mailbox,
  Outbound,
  ThreadDetail,
  ThreadSummary,
} from '@luma/api-contract';

/** Deterministic inbox data for stories and tests. Provider data is written in English. */
export const inboxOrg = '33333333-3333-4333-8333-333333333333';

export const alex = '22222222-2222-4222-8222-222222222222';

export const sam = '55555555-5555-4555-8555-555555555555';

export const inboxNow = Date.parse('2026-10-08T12:00:00.000Z');

const connectionId = '66666666-6666-4666-8666-666666666666';
const supplierId = '77777777-7777-4777-8777-777777777777';
const purchaseOrderId = '88888888-8888-4888-8888-888888888888';
const orderId = '99999999-9999-4999-8999-999999999999';

export const mailboxFixture: Mailbox = {
  connectionId,
  label: 'Purchasing mailbox',
  provider: 'Gmail',
  address: 'purchasing@lumashop.example',
  connectionStatus: 'active',
  canSend: true,
  state: 'current',
  stateReason: null,
  lastSyncedAt: '2026-10-08T11:58:00.000Z',
  coveredUntil: '2026-10-08T11:57:30.000Z',
  settings: {
    backfillDays: 30,
    replyHours: 24,
    approveAll: false,
    paused: false,
  },
  rules: [
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      kind: 'sender_domain',
      value: 'northstar.example',
      party: { kind: 'supplier', supplierId },
      partyLabel: 'Northstar Supply',
      backfilledAt: '2026-10-01T09:00:00.000Z',
      createdBy: alex,
      createdAt: '2026-10-01T08:55:00.000Z',
    },
    {
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      kind: 'recipient_address',
      value: 'orders@lumashop.example',
      party: { kind: 'customer' },
      partyLabel: null,
      backfilledAt: null,
      createdBy: alex,
      createdAt: '2026-10-08T11:50:00.000Z',
    },
  ],
  revision: 3,
};

const base: ThreadSummary = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  connectionId,
  mailboxLabel: 'purchasing@lumashop.example',
  subject: 'Re: PO-2026-0412 delivery date',
  correspondent: {
    address: 'orders@northstar.example',
    name: 'Northstar Supply',
  },
  snippet:
    'We can deliver 120 × LAMP-01 on 21 October. The confirmation is attached.',
  status: 'open',
  ownerId: alex,
  replyDueAt: '2026-10-08T09:00:00.000Z',
  replyDueSource: 'automatic',
  overdue: true,
  awaitingReply: true,
  lastMessageAt: '2026-10-07T09:00:00.000Z',
  messageCount: 3,
  links: [
    { kind: 'purchase_order', id: purchaseOrderId, label: 'PO-2026-0412' },
    { kind: 'supplier', id: supplierId, label: 'Northstar Supply' },
  ],
  attachmentCount: 1,
  factsToReview: 3,
  revision: 4,
};

export const threadFixtures: ThreadSummary[] = [
  base,
  {
    ...base,
    id: 'bbbbbbbb-0000-4000-8000-000000000002',
    subject: 'Where is my order #48213?',
    correspondent: { address: 'jamie@customer.example', name: 'Jamie Lee' },
    snippet: 'Hi, my order was supposed to arrive yesterday. Can you check?',
    ownerId: null,
    replyDueAt: '2026-10-08T18:00:00.000Z',
    replyDueSource: 'manual',
    overdue: false,
    lastMessageAt: '2026-10-08T10:30:00.000Z',
    messageCount: 1,
    links: [{ kind: 'order', id: orderId, label: '#48213' }],
    attachmentCount: 0,
    factsToReview: 0,
    revision: 1,
  },
  {
    ...base,
    id: 'bbbbbbbb-0000-4000-8000-000000000003',
    subject: 'Price list 2027',
    correspondent: { address: 'sales@northstar.example', name: null },
    snippet: 'Please find our updated price list attached.',
    status: 'waiting',
    ownerId: sam,
    replyDueAt: null,
    replyDueSource: null,
    overdue: false,
    awaitingReply: false,
    lastMessageAt: '2026-10-06T14:00:00.000Z',
    messageCount: 2,
    links: [],
    attachmentCount: 2,
    factsToReview: 0,
    revision: 2,
  },
];

const documentId = 'cccccccc-0000-4000-8000-000000000001';

const draft: Outbound = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  threadId: base.id,
  connectionId,
  to: [{ address: 'orders@northstar.example', name: 'Northstar Supply' }],
  cc: [],
  subject: 'Re: PO-2026-0412 delivery date',
  text: 'Hello Northstar team,\n\nthank you. We confirm delivery of 120 × LAMP-01 on 21 October 2026 for PO-2026-0412.\n\nBest regards\nLuma Shop purchasing',
  citations: [
    {
      record: {
        kind: 'purchase_order',
        id: purchaseOrderId,
        label: 'PO-2026-0412',
      },
      statement: 'Ordered 120 × LAMP-01, expected 21 Oct 2026',
      observedAt: '2026-10-08T11:50:00.000Z',
      freshness: 'fresh',
    },
    {
      record: { kind: 'supplier', id: supplierId, label: 'Northstar Supply' },
      statement: 'Supplier contact orders@northstar.example',
      observedAt: '2026-10-06T08:00:00.000Z',
      freshness: 'stale',
    },
  ],
  consequential: ['date', 'quantity'],
  state: 'draft',
  stateReason: null,
  requestedBy: alex,
  decisionId: null,
  approverId: null,
  sentMessageId: null,
  canEdit: true,
  canRequest: true,
  canApprove: false,
  canSend: false,
  canCheck: false,
  revision: 1,
  createdAt: '2026-10-08T11:55:00.000Z',
  updatedAt: '2026-10-08T11:55:00.000Z',
};

export const outboundFixtures = {
  draft,
  approval: {
    ...draft,
    id: 'dddddddd-0000-4000-8000-000000000002',
    state: 'approval_required',
    requestedBy: sam,
    decisionId: 'messaging:reply:dddddddd',
    canEdit: false,
    canRequest: false,
    canApprove: true,
  },
  uncertain: {
    ...draft,
    id: 'dddddddd-0000-4000-8000-000000000003',
    state: 'uncertain',
    canEdit: false,
    canRequest: false,
    canCheck: true,
  },
} satisfies Record<string, Outbound>;

export const threadDetailFixture: ThreadDetail = {
  thread: base,
  messages: [
    {
      id: 'eeeeeeee-0000-4000-8000-000000000001',
      threadId: base.id,
      direction: 'outbound',
      from: { address: 'purchasing@lumashop.example', name: 'Luma Shop' },
      to: [{ address: 'orders@northstar.example', name: 'Northstar Supply' }],
      cc: [],
      subject: 'PO-2026-0412 delivery date',
      text: 'Hello,\n\ncan you confirm the delivery date for PO-2026-0412?\n\nThanks',
      truncated: false,
      sentAt: '2026-10-05T08:00:00.000Z',
      receivedAt: '2026-10-05T08:00:01.000Z',
      source: {
        provider: 'gmail',
        messageId: '18c2f0a1b2c3d4e5',
        rfcMessageId: 'CAF1234@mail.lumashop.example',
      },
      origin: 'sync',
      attachments: [],
      retainUntil: '2027-10-05T08:00:00.000Z',
      purgedAt: null,
    },
    {
      id: 'eeeeeeee-0000-4000-8000-000000000002',
      threadId: base.id,
      direction: 'inbound',
      from: { address: 'orders@northstar.example', name: 'Northstar Supply' },
      to: [{ address: 'purchasing@lumashop.example', name: null }],
      cc: [{ address: 'logistics@northstar.example', name: null }],
      subject: 'Re: PO-2026-0412 delivery date',
      text: 'Dear purchasing team,\n\nwe can deliver 120 × LAMP-01 on 21 October.\nThe order confirmation is attached.\n\nKind regards\nNorthstar Supply',
      truncated: false,
      sentAt: '2026-10-07T09:00:00.000Z',
      receivedAt: '2026-10-07T09:00:04.000Z',
      source: {
        provider: 'gmail',
        messageId: '18c3a9b8c7d6e5f4',
        rfcMessageId: 'NS-889911@northstar.example',
      },
      origin: 'sync',
      attachments: [
        {
          filename: 'confirmation-PO-2026-0412.pdf',
          mimeType: 'application/pdf',
          size: 48_210,
          documentId,
        },
      ],
      retainUntil: '2027-10-07T09:00:00.000Z',
      purgedAt: null,
    },
    {
      id: 'eeeeeeee-0000-4000-8000-000000000003',
      threadId: base.id,
      direction: 'inbound',
      from: { address: 'orders@northstar.example', name: 'Northstar Supply' },
      to: [{ address: 'purchasing@lumashop.example', name: null }],
      cc: [],
      subject: 'Re: PO-2026-0412 delivery date',
      text: null,
      truncated: false,
      sentAt: '2026-09-01T09:00:00.000Z',
      receivedAt: '2026-09-01T09:00:00.000Z',
      source: {
        provider: 'gmail',
        messageId: '18a0000000000001',
        rfcMessageId: null,
      },
      origin: 'sync',
      attachments: [],
      retainUntil: '2026-10-01T09:00:00.000Z',
      purgedAt: '2026-10-01T09:05:00.000Z',
    },
  ],
  links: [
    {
      id: 'ffffffff-0000-4000-8000-000000000001',
      record: { kind: 'supplier', id: supplierId, label: 'Northstar Supply' },
      method: 'rule',
      state: 'active',
      evidence: {
        messageId: null,
        ruleId: 'aaaaaaaa-0000-4000-8000-000000000001',
        text: 'orders@northstar.example',
        span: null,
      },
      createdBy: 'luma',
      createdAt: '2026-10-05T08:00:05.000Z',
    },
    {
      id: 'ffffffff-0000-4000-8000-000000000002',
      record: {
        kind: 'purchase_order',
        id: purchaseOrderId,
        label: 'PO-2026-0412',
      },
      method: 'reference',
      state: 'active',
      evidence: {
        messageId: 'eeeeeeee-0000-4000-8000-000000000001',
        ruleId: null,
        text: 'PO-2026-0412',
        span: { start: 44, end: 56 },
      },
      createdBy: 'luma',
      createdAt: '2026-10-05T08:00:05.000Z',
    },
    {
      id: 'ffffffff-0000-4000-8000-000000000003',
      record: { kind: 'order', id: orderId, label: '#0412' },
      method: 'reference',
      state: 'suggested',
      evidence: {
        messageId: 'eeeeeeee-0000-4000-8000-000000000002',
        ruleId: null,
        text: '0412',
        span: null,
      },
      createdBy: 'luma',
      createdAt: '2026-10-07T09:00:06.000Z',
    },
  ],
  notes: [
    {
      id: '12121212-0000-4000-8000-000000000001',
      authorId: sam,
      body: 'Northstar was late twice this quarter. Ask for tracking once shipped.',
      createdAt: '2026-10-07T10:00:00.000Z',
    },
  ],
  events: [
    {
      id: '13131313-0000-4000-8000-000000000001',
      type: 'received',
      actor: { kind: 'luma', id: 'luma' },
      details: {},
      occurredAt: '2026-10-07T09:00:05.000Z',
    },
    {
      id: '13131313-0000-4000-8000-000000000002',
      type: 'assigned',
      actor: { kind: 'user', id: sam },
      details: { ownerId: alex },
      occurredAt: '2026-10-07T09:30:00.000Z',
    },
    {
      id: '13131313-0000-4000-8000-000000000003',
      type: 'handed_off',
      actor: { kind: 'luma', id: 'luma' },
      details: { record: 'PO-2026-0412' },
      occurredAt: '2026-10-07T09:00:07.000Z',
    },
  ],
  documents: [
    {
      id: documentId,
      messageId: 'eeeeeeee-0000-4000-8000-000000000002',
      threadId: base.id,
      filename: 'confirmation-PO-2026-0412.pdf',
      mimeType: 'application/pdf',
      size: 48_210,
      sha256: 'a1b2',
      version: 2,
      previousId: 'cccccccc-0000-4000-8000-000000000000',
      duplicateOf: null,
      state: 'ready',
      stateReason: null,
      factsToReview: 3,
      receivedAt: '2026-10-07T09:00:04.000Z',
    },
  ],
  outbound: [draft],
  permissions: { canManage: true, canSend: true },
};

const pageText = `ORDER CONFIRMATION

Northstar Supply GmbH
Reference: PO-2026-0412

Item       Qty   Unit price
LAMP-01    120   EUR 14.50

Delivery date: 2026-10-21
Total: EUR 1,740.00`;

const at = (quote: string) => {
  const start = pageText.indexOf(quote);

  return { kind: 'text' as const, page: 1, start, end: start + quote.length };
};

const fact = (
  overrides: Partial<Fact> & Pick<Fact, 'id' | 'value' | 'locator' | 'quote'>,
): Fact => ({
  documentId,
  confidence: 'high',
  match: { state: 'not_applicable', record: null, candidates: [] },
  status: 'proposed',
  origin: 'model',
  change: 'unchanged',
  review: null,
  createdAt: '2026-10-07T09:01:00.000Z',
  ...overrides,
});

export const documentFixture: DocumentDetail = {
  document: threadDetailFixture.documents[0]!,
  representation: { kind: 'text', pages: [pageText] },
  facts: [
    fact({
      id: '14141414-0000-4000-8000-000000000001',
      value: {
        kind: 'reference',
        role: 'purchase_order',
        text: 'PO-2026-0412',
      },
      locator: at('PO-2026-0412'),
      quote: 'PO-2026-0412',
      match: {
        state: 'matched',
        record: {
          kind: 'purchase_order',
          id: purchaseOrderId,
          label: 'PO-2026-0412',
        },
        candidates: [],
      },
      status: 'confirmed',
      review: {
        outcome: 'confirmed',
        by: sam,
        at: '2026-10-07T10:05:00.000Z',
        original: null,
      },
    }),
    fact({
      id: '14141414-0000-4000-8000-000000000002',
      value: {
        kind: 'line',
        sku: 'LAMP-01',
        description: null,
        quantity: '120',
        unit: null,
        unitPrice: { amount: '14.50', currency: 'EUR' },
      },
      locator: at('LAMP-01    120   EUR 14.50'),
      quote: 'LAMP-01    120   EUR 14.50',
      change: 'changed',
    }),
    fact({
      id: '14141414-0000-4000-8000-000000000003',
      value: { kind: 'date', role: 'delivery', date: '2026-10-21' },
      locator: at('2026-10-21'),
      quote: '2026-10-21',
      confidence: 'low',
      status: 'needs_correction',
      change: 'new',
    }),
    fact({
      id: '14141414-0000-4000-8000-000000000004',
      value: {
        kind: 'party',
        role: 'supplier',
        name: 'Northstar Supply GmbH',
        email: null,
      },
      locator: at('Northstar Supply GmbH'),
      quote: 'Northstar Supply GmbH',
      match: {
        state: 'ambiguous',
        record: null,
        candidates: [
          { kind: 'supplier', id: supplierId, label: 'Northstar Supply' },
          {
            kind: 'supplier',
            id: '78787878-7878-4878-8878-787878787878',
            label: 'Northstar Supply (old)',
          },
        ],
      },
      status: 'needs_correction',
    }),
  ],
  removedFacts: [
    fact({
      id: '14141414-0000-4000-8000-000000000005',
      value: { kind: 'date', role: 'delivery', date: '2026-10-14' },
      locator: { kind: 'text', page: 1, start: 0, end: 5 },
      quote: '2026-10-14',
    }),
  ],
  extraction: { available: true, reason: null },
  canReview: true,
};

export const sheetDocumentFixture: DocumentDetail = {
  ...documentFixture,
  document: {
    ...documentFixture.document,
    id: 'cccccccc-0000-4000-8000-000000000002',
    filename: 'price-list-2027.xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    version: 1,
    previousId: null,
    factsToReview: 1,
  },
  representation: {
    kind: 'sheets',
    sheets: [
      {
        name: 'Prices',
        rows: [
          ['SKU', 'Description', 'Unit price', 'Currency'],
          ['LAMP-01', 'Desk lamp', '15.20', 'EUR'],
          ['LAMP-02', 'Floor lamp', '41.00', 'EUR'],
        ],
      },
    ],
  },
  facts: [
    fact({
      id: '15151515-0000-4000-8000-000000000001',
      value: {
        kind: 'line',
        sku: 'LAMP-01',
        description: 'Desk lamp',
        quantity: null,
        unit: null,
        unitPrice: { amount: '15.20', currency: 'EUR' },
      },
      locator: {
        kind: 'cells',
        sheet: 'Prices',
        row: 2,
        rowEnd: 2,
        column: 1,
        columnEnd: 4,
      },
      quote: 'LAMP-01 | Desk lamp | 15.20 | EUR',
      origin: 'table',
      change: null,
    }),
  ],
  removedFacts: [],
  extraction: {
    available: false,
    reason: 'No EU zero-retention model route is configured.',
  },
};
