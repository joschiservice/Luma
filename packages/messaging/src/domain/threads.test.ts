import { describe, expect, it } from 'vitest';

import type { MailboxRule } from './mailbox.js';
import type { StoredMessage } from './threads.js';
import {
  aggregateThread,
  documentFamily,
  documentIntake,
  matchingRules,
  replyDeadline,
} from './threads.js';

const message = (
  direction: StoredMessage['direction'],
  receivedAt: string,
  text: string | null = 'Hello',
): StoredMessage => ({
  direction,
  text,
  document: {
    from:
      direction === 'inbound'
        ? { address: 'anna@supplier.example', name: 'Anna' }
        : { address: 'ops@shop.example', name: null },
    to:
      direction === 'inbound'
        ? [{ address: 'ops@shop.example', name: null }]
        : [{ address: 'anna@supplier.example', name: 'Anna' }],
    cc: [],
    subject: 'PO-1',
    attachments: [
      {
        attachment: { externalId: 'a', scopeKey: '' },
        filename: 'x.pdf',
        mimeType: 'application/pdf',
        size: 1,
      },
    ],
    receivedAt,
  },
});

describe('thread aggregates', () => {
  it('derives counts, latest times, correspondent and snippet from every message', () => {
    expect(
      aggregateThread([
        message('outbound', '2026-10-11T10:00:00.000Z'),
        message('inbound', '2026-10-11T09:00:00.000Z', 'First\n\n  question'),
        message('inbound', '2026-10-11T11:00:00.000Z', null),
      ]),
    ).toEqual({
      subject: 'PO-1',
      document: {
        participants: [
          { address: 'anna@supplier.example', name: 'Anna' },
          { address: 'ops@shop.example', name: null },
        ],
        correspondent: { address: 'anna@supplier.example', name: 'Anna' },
        snippet: '',
        attachmentCount: 3,
      },
      lastMessageAt: '2026-10-11T11:00:00.000Z',
      lastInboundAt: '2026-10-11T11:00:00.000Z',
      lastOutboundAt: '2026-10-11T10:00:00.000Z',
      messageCount: 3,
    });
  });
});

describe('reply deadlines', () => {
  it('is due after the reply hours while unanswered, and cleared by a newer reply', () => {
    expect(
      replyDeadline({
        lastInboundAt: '2026-10-11T09:00:00.000Z',
        lastOutboundAt: null,
        manualDueAt: null,
        replyHours: 24,
      }),
    ).toBe('2026-10-12T09:00:00.000Z');
    expect(
      replyDeadline({
        lastInboundAt: '2026-10-11T09:00:00.000Z',
        lastOutboundAt: '2026-10-11T10:00:00.000Z',
        manualDueAt: null,
        replyHours: 24,
      }),
    ).toBeNull();
  });

  it('keeps a deadline someone set, even after a reply', () => {
    expect(
      replyDeadline({
        lastInboundAt: '2026-10-11T09:00:00.000Z',
        lastOutboundAt: '2026-10-11T10:00:00.000Z',
        manualDueAt: '2026-10-13T08:00:00.000Z',
        replyHours: 24,
      }),
    ).toBe('2026-10-13T08:00:00.000Z');
  });
});

describe('document intake', () => {
  it('reads supported files up to 10 MB and records why others are not read', () => {
    expect(
      documentIntake({
        filename: 'Order.PDF',
        mimeType: 'application/octet-stream',
        size: 10,
      }),
    ).toEqual({ state: 'pending' });
    expect(
      documentIntake({
        filename: 'a.csv',
        mimeType: 'text/csv',
        size: 11 * 1024 * 1024,
      }),
    ).toEqual({ state: 'unsupported', failure: 'too_large' });
    expect(
      documentIntake({
        filename: 'a.docx',
        mimeType: 'application/msword',
        size: 1,
      }),
    ).toEqual({ state: 'unsupported', failure: 'unsupported_type' });
    expect(
      documentIntake({ filename: 'logo.png', mimeType: 'image/png', size: 1 }),
    ).toBeNull();
  });

  it('groups document versions within a thread', () => {
    expect(documentFamily('Confirmation PO-17 v2.pdf', 't1')).toBe(
      documentFamily('confirmation_po-17.pdf', 't1'),
    );
    expect(documentFamily('a.pdf', 't1')).not.toBe(
      documentFamily('a.csv', 't1'),
    );
    expect(documentFamily('a.pdf', 't1')).not.toBe(
      documentFamily('a.pdf', 't2'),
    );
  });
});

describe('rule matching', () => {
  const rules: MailboxRule[] = [
    {
      id: 'domain',
      connectionId: 'm',
      kind: 'sender_domain',
      value: 'supplier.example',
      party: { kind: 'supplier', supplierId: 's' },
      backfilledAt: null,
      createdBy: 'u',
      createdAt: 'x',
    },
    {
      id: 'alias',
      connectionId: 'm',
      kind: 'recipient_address',
      value: 'orders@shop.example',
      party: { kind: 'other' },
      backfilledAt: null,
      createdBy: 'u',
      createdAt: 'x',
    },
  ];

  it('matches senders by domain and subdomain, and sent messages by recipient', () => {
    expect(
      matchingRules(
        {
          direction: 'inbound',
          from: { address: 'a@eu.supplier.example', name: null },
          to: [{ address: 'orders@shop.example', name: null }],
          cc: [],
          labels: [],
        },
        rules,
      ).map((m) => [m.rule.id, m.address]),
    ).toEqual([
      ['domain', 'a@eu.supplier.example'],
      ['alias', 'orders@shop.example'],
    ]);
    expect(
      matchingRules(
        {
          direction: 'outbound',
          from: { address: 'ops@shop.example', name: null },
          to: [{ address: 'anna@supplier.example', name: null }],
          cc: [],
          labels: [],
        },
        rules,
      ).map((m) => m.rule.id),
    ).toEqual(['domain']);
    expect(
      matchingRules(
        {
          direction: 'inbound',
          from: { address: 'a@notsupplier.example', name: null },
          to: [],
          cc: [],
          labels: [],
        },
        rules,
      ),
    ).toEqual([]);
  });
});
