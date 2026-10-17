import { describe, expect, it } from 'vitest';

import { consequentialReasons } from './consequential.js';
import type { RecordState, ReplyBasis } from './replies.js';
import {
  composeReply,
  detectLanguage,
  repliedOutboundId,
  replyActions,
  replyProvesDelivery,
  replyRecipients,
  replySubject,
  threadHeaders,
} from './replies.js';

const now = new Date('2026-10-11T12:00:00.000Z');
const hoursAgo = (hours: number) =>
  new Date(now.getTime() - hours * 3_600_000).toISOString();

const inbound = (input: Partial<ReplyBasis> = {}): ReplyBasis => ({
  direction: 'inbound',
  from: { address: 'Kim@Customer.example', name: 'Kim' },
  replyTo: [],
  subject: 'Where is my order 1001?',
  text: 'Hi, I am still waiting for my order. Can you please check?',
  rfcMessageId: 'm1@customer.example',
  references: [],
  receivedAt: hoursAgo(1),
  ...input,
});

const order = (
  input: Partial<Extract<RecordState, { kind: 'order' }>> = {},
): RecordState => ({
  kind: 'order',
  label: '#1001',
  observedAt: hoursAgo(2),
  status: 'open',
  paymentStatus: 'paid',
  fulfillment: 'partial',
  dueAt: '2026-10-14T00:00:00.000Z',
  tracking: [{ carrier: 'DHL', number: '00340434' }],
  ...input,
});

const draft = (
  records: Parameters<typeof composeReply>[0]['records'],
  message = inbound(),
) =>
  composeReply({
    latestInbound: message,
    latest: message,
    mailboxAddress: 'ops@shop.example',
    records,
    now,
  });

describe('reply drafts', () => {
  it('restates fresh records with a citation for each statement', () => {
    const reply = draft([
      { kind: 'order', id: 'o1', label: '#1001', state: order() },
    ]);

    expect(reply.language).toBe('en');
    expect(reply.to).toEqual([
      { address: 'kim@customer.example', name: 'Kim' },
    ]);
    expect(reply.subject).toBe('Re: Where is my order 1001?');
    expect(reply.text).toContain('Hello Kim,');
    expect(reply.text).toContain(
      'Order #1001 has partly shipped. The payment is recorded as paid. Tracking: DHL 00340434. It is planned to ship by 2026-10-14.',
    );
    expect(reply.citations).toEqual([
      {
        record: { kind: 'order', id: 'o1', label: '#1001' },
        statement: expect.stringContaining('Order #1001 has partly shipped.'),
        observedAt: hoursAgo(2),
        freshness: 'fresh',
      },
    ]);
    for (const citation of reply.citations)
      expect(reply.text).toContain(citation.statement);
    expect(reply.inReplyTo).toBe('m1@customer.example');
    expect(reply.references).toEqual(['m1@customer.example']);
    // A planned ship date is a commitment, so the cited draft needs approval.
    expect(consequentialReasons({ ...reply, approveAll: false })).toContain(
      'date',
    );
  });

  it('states missing and stale records as unconfirmed and never fills them in', () => {
    const reply = draft([
      { kind: 'order', id: 'o1', label: '#1001', state: null },
      {
        kind: 'purchase_order',
        id: 'p1',
        label: 'PO-7',
        state: {
          kind: 'purchase_order',
          label: 'PO-7',
          observedAt: hoursAgo(30),
          stage: 'confirmed',
          expectedDate: '2026-10-20',
          lines: [
            {
              description: 'Blue mug',
              unit: 'pcs',
              confirmed: 40,
              outstanding: 40,
              expectedDate: '2026-10-20',
            },
          ],
        },
      },
    ]);

    expect(reply.text).toContain(
      "I can't confirm the current status of order #1001 right now.",
    );
    expect(reply.text).toContain(
      "The information I have on purchase order PO-7 is more than a day old, so I can't confirm its current status right now.",
    );
    expect(reply.text).not.toContain('2026-10-20');
    expect(reply.text).not.toContain('40');
    expect(reply.citations.map((c) => [c.freshness, c.observedAt])).toEqual([
      ['missing', null],
      ['stale', hoursAgo(30)],
    ]);
  });

  it('answers German messages in German', () => {
    const message = inbound({
      subject: 'AW: Bestellung PO-7',
      text: 'Hallo, wann kommt die Lieferung? Vielen Dank und viele Grüße',
      from: { address: 'anna@acme.example', name: null },
    });
    const reply = draft(
      [
        {
          kind: 'purchase_order',
          id: 'p1',
          label: 'PO-7',
          state: {
            kind: 'purchase_order',
            label: 'PO-7',
            observedAt: hoursAgo(1),
            stage: 'awaiting_confirmation',
            expectedDate: null,
            lines: [
              {
                description: 'Blue mug',
                unit: 'pcs',
                confirmed: null,
                outstanding: 40,
                expectedDate: null,
              },
            ],
          },
        },
        {
          kind: 'supplier',
          id: 's1',
          label: 'Acme',
          state: { kind: 'supplier', label: 'Acme', observedAt: hoursAgo(0) },
        },
        { kind: 'case', id: 'c1', label: 'Issue', state: null },
      ],
      message,
    );

    expect(reply.language).toBe('de');
    expect(reply.subject).toBe('Re: Bestellung PO-7');
    expect(reply.text.split('\n')[0]).toBe('Hallo Acme,');
    expect(reply.text).toContain(
      'Die Bestellung PO-7 wartet auf Ihre Bestätigung. Blue mug: 40 pcs offen.',
    );
    expect(reply.text).toContain('Viele Grüße');
    expect(reply.citations.map((c) => c.record.kind)).toEqual([
      'purchase_order',
      'supplier',
    ]);
  });

  it('never quotes the inbound message and says it is looking into it without records', () => {
    const reply = draft([]);

    expect(reply.text).not.toContain('still waiting');
    expect(reply.text).toContain(
      'I am looking into this and will get back to you.',
    );
    expect(reply.citations).toEqual([]);
  });
});

describe('reply addressing', () => {
  it('detects German only when the text reads German', () => {
    expect(detectLanguage('Sehr geehrte Damen und Herren, bitte prüfen')).toBe(
      'de',
    );
    expect(detectLanguage('Please check my order')).toBe('en');
    expect(detectLanguage('PO-7')).toBe('en');
  });

  it('normalizes reply and forward marks', () => {
    expect(replySubject('RE: AW: Fwd: Delivery')).toBe('Re: Delivery');
    expect(replySubject('')).toBe('Re: (no subject)');
  });

  it('replies to reply-to addresses without the mailbox itself', () => {
    expect(
      replyRecipients(
        {
          from: { address: 'noreply@acme.example', name: null },
          replyTo: [
            { address: 'Ops@Shop.example', name: null },
            { address: 'sales@acme.example', name: 'Sales' },
          ],
        },
        'ops@shop.example',
      ),
    ).toEqual([{ address: 'sales@acme.example', name: 'Sales' }]);
  });

  it('threads under the latest message and drops malformed IDs', () => {
    expect(
      threadHeaders(
        inbound({
          rfcMessageId: 'm2@x.example',
          references: ['m0@x.example', 'bad id', 'm1@x.example'],
        }),
      ),
    ).toEqual({
      inReplyTo: 'm2@x.example',
      references: ['m0@x.example', 'm1@x.example', 'm2@x.example'],
    });
  });
});

describe('reply actions', () => {
  const reader = (id: string, permissions: string[]) => ({
    id,
    can: (permission: string) => permissions.includes(permission),
  });
  const reply = (
    input: Partial<Parameters<typeof replyActions>[0]> = {},
  ): Parameters<typeof replyActions>[0] => ({
    state: 'draft',
    requestedBy: 'alice',
    expiresAt: null,
    approverId: null,
    permission: 'gmail:messages.send',
    ...input,
  });
  const sender = ['messages.send'];
  const approver = [
    'messages.send',
    'decisions.respond',
    'gmail:messages.send',
  ];

  it('lets only the author edit, request and send', () => {
    expect(replyActions(reply(), reader('alice', sender), now)).toMatchObject({
      canEdit: true,
      canRequest: true,
    });
    expect(replyActions(reply(), reader('bob', approver), now)).toMatchObject({
      canEdit: false,
      canRequest: false,
    });
    expect(
      replyActions(reply({ state: 'approved' }), reader('alice', sender), now)
        .canSend,
    ).toBe(true);
    expect(
      replyActions(reply({ state: 'approved' }), reader('bob', approver), now)
        .canSend,
    ).toBe(false);
  });

  it('needs someone else with the app permission to approve, before expiry', () => {
    const pending = reply({
      state: 'approval_required',
      expiresAt: hoursAgo(-1),
    });
    expect(
      replyActions(pending, reader('alice', approver), now).canApprove,
    ).toBe(false);
    expect(replyActions(pending, reader('bob', approver), now).canApprove).toBe(
      true,
    );
    expect(
      replyActions(
        pending,
        reader('bob', ['messages.send', 'decisions.respond']),
        now,
      ).canApprove,
    ).toBe(false);
    expect(
      replyActions(
        { ...pending, expiresAt: hoursAgo(1) },
        reader('bob', approver),
        now,
      ),
    ).toMatchObject({ state: 'expired', canApprove: false });
  });

  it('offers a check for unconfirmed sends only', () => {
    for (const state of ['sending', 'uncertain'] as const)
      expect(
        replyActions(reply({ state }), reader('bob', sender), now).canCheck,
      ).toBe(true);
    expect(
      replyActions(reply({ state: 'sent' }), reader('bob', sender), now)
        .canCheck,
    ).toBe(false);
  });
});

describe('delivery proven by a reply', () => {
  const send = {
    id: '6f1c2c1e-0000-4000-8000-000000000001',
    fromAddress: 'ops@shop.example',
    recipients: [{ address: 'Anna@Acme.example', name: 'Anna' }],
  };
  const sentId = `luma.${send.id}@shop.example`;
  const reply = (
    input: Partial<Parameters<typeof replyProvesDelivery>[1]> = {},
  ): Parameters<typeof replyProvesDelivery>[1] => ({
    direction: 'inbound',
    from: { address: 'anna@acme.example', name: 'Anna' },
    senderAuthentication: 'aligned',
    inReplyTo: sentId,
    references: [sentId],
    ...input,
  });

  it('accepts an authenticated direct reply from a recipient', () => {
    expect(replyProvesDelivery(send, reply())).toBe(true);
    expect(repliedOutboundId(reply())).toBe(send.id);
    // Without In-Reply-To the last reference is the parent.
    expect(
      replyProvesDelivery(
        send,
        reply({ inReplyTo: null, references: ['x@y', sentId] }),
      ),
    ).toBe(true);
    expect(
      replyProvesDelivery(send, reply({ inReplyTo: sentId.toUpperCase() })),
    ).toBe(true);
  });

  it('rejects unauthenticated senders, other senders and delivery reports', () => {
    expect(
      replyProvesDelivery(send, reply({ senderAuthentication: 'unaligned' })),
    ).toBe(false);
    expect(
      replyProvesDelivery(send, reply({ senderAuthentication: 'unknown' })),
    ).toBe(false);
    expect(
      replyProvesDelivery(
        send,
        reply({ from: { address: 'someone@acme.example', name: null } }),
      ),
    ).toBe(false);
    expect(
      replyProvesDelivery(
        send,
        reply({
          deliveryFailure: {
            originalMessageId: sentId,
            recipient: 'anna@acme.example',
            status: '5.1.1',
          },
        }),
      ),
    ).toBe(false);
    expect(replyProvesDelivery(send, reply({ direction: 'outbound' }))).toBe(
      false,
    );
  });

  it('rejects replies to another message, even when the chain names the send', () => {
    const later = 'luma.6f1c2c1e-0000-4000-8000-000000000002@shop.example';
    expect(
      replyProvesDelivery(
        send,
        reply({ inReplyTo: later, references: [sentId, later] }),
      ),
    ).toBe(false);
    expect(
      replyProvesDelivery(
        send,
        reply({ inReplyTo: null, references: [sentId, 'other@acme.example'] }),
      ),
    ).toBe(false);
    expect(
      replyProvesDelivery(
        send,
        reply({ inReplyTo: `luma.${send.id}@attacker.example` }),
      ),
    ).toBe(false);
    expect(repliedOutboundId(reply({ inReplyTo: 'm1@acme.example' }))).toBe(
      null,
    );
  });
});
