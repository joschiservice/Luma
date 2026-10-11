import { describe, expect, it } from 'vitest';

import {
  handoffOrder,
  mergeLink,
  proposeLinks,
  referenceTokens,
} from './linking.js';
import type { MailboxRule } from './mailbox.js';

const rule = (overrides: Partial<MailboxRule> = {}): MailboxRule => ({
  id: 'rule-1',
  connectionId: 'mailbox',
  kind: 'sender_domain',
  value: 'supplier.example',
  party: { kind: 'supplier', supplierId: 'supplier-1' },
  backfilledAt: null,
  createdBy: 'user',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('reference tokens', () => {
  it('finds order and purchase-order references with their spans in the text', () => {
    const text = 'Hello, about order #1001 and PO-2026-017.';
    const tokens = referenceTokens('Re: Delivery for PO-2026-017', text);

    expect(tokens.map((t) => t.key)).toEqual(['1001', 'PO-2026-017']);
    expect(text.slice(tokens[0]!.span!.start, tokens[0]!.span!.end)).toBe(
      '1001',
    );
    expect(text.slice(tokens[1]!.span!.start, tokens[1]!.span!.end)).toBe(
      'PO-2026-017',
    );
  });

  it('ignores short bare numbers, words without digits, and parts of addresses', () => {
    expect(
      referenceTokens('', 'Send 12 boxes to sales@acme123.example today'),
    ).toEqual([]);
    expect(
      referenceTokens('Order 4711', '').map((t) => [t.key, t.span]),
    ).toEqual([['4711', null]]);
  });
});

describe('link proposals', () => {
  it('links a supplier rule and a unique reference, and only suggests ambiguous references', () => {
    const [token] = referenceTokens('', 'See 1001');
    const proposals = proposeLinks({
      messageId: 'message-1',
      rules: [{ rule: rule(), address: 'anna@supplier.example' }],
      customers: [],
      references: [
        {
          token: token!,
          records: [
            { kind: 'order', id: 'order-a' },
            { kind: 'purchase_order', id: 'po-b' },
          ],
        },
      ],
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        kind: 'supplier',
        recordId: 'supplier-1',
        method: 'rule',
        state: 'active',
        evidence: expect.objectContaining({
          ruleId: 'rule-1',
          text: 'anna@supplier.example',
        }),
      }),
      expect.objectContaining({ kind: 'order', state: 'suggested' }),
      expect.objectContaining({ kind: 'purchase_order', state: 'suggested' }),
    ]);
  });

  it('activates a unique customer address and keeps evidence', () => {
    expect(
      proposeLinks({
        messageId: 'm',
        rules: [{ rule: rule({ party: { kind: 'customer' } }), address: 'x' }],
        customers: [{ address: 'kim@example.com', ids: ['customer-1'] }],
        references: [],
      }),
    ).toEqual([
      {
        kind: 'customer',
        recordId: 'customer-1',
        method: 'address',
        state: 'active',
        evidence: {
          messageId: 'm',
          ruleId: null,
          text: 'kim@example.com',
          span: null,
        },
      },
    ]);
  });

  it('never re-adds a removed link and upgrades suggestions on unique evidence', () => {
    expect(mergeLink({ state: 'removed' }, { state: 'active' })).toBe('keep');
    expect(mergeLink({ state: 'suggested' }, { state: 'active' })).toBe(
      'activate',
    );
    expect(mergeLink({ state: 'active' }, { state: 'suggested' })).toBe('keep');
    expect(mergeLink(null, { state: 'suggested' })).toBe('insert');
  });
});

describe('procurement handoff', () => {
  const supplierOf = new Map([['po-1', 'supplier-1']]);

  it('hands off when exactly one purchase order is linked and the sender is its supplier', () => {
    const links = [
      {
        kind: 'purchase_order' as const,
        recordId: 'po-1',
        state: 'active' as const,
      },
    ];

    expect(
      handoffOrder({
        links,
        supplierOf,
        senderSuppliers: new Set(['supplier-1']),
      }),
    ).toBe('po-1');
    expect(
      handoffOrder({ links, supplierOf, senderSuppliers: new Set(['other']) }),
    ).toBeNull();
    expect(
      handoffOrder({
        links: [
          ...links,
          { kind: 'supplier', recordId: 'supplier-1', state: 'active' },
        ],
        supplierOf,
        senderSuppliers: new Set(),
      }),
    ).toBe('po-1');
  });

  it('does not guess between several purchase orders or use suggestions', () => {
    expect(
      handoffOrder({
        links: [
          { kind: 'purchase_order', recordId: 'po-1', state: 'active' },
          { kind: 'purchase_order', recordId: 'po-2', state: 'active' },
        ],
        supplierOf,
        senderSuppliers: new Set(['supplier-1']),
      }),
    ).toBeNull();
    expect(
      handoffOrder({
        links: [
          { kind: 'purchase_order', recordId: 'po-1', state: 'suggested' },
        ],
        supplierOf,
        senderSuppliers: new Set(['supplier-1']),
      }),
    ).toBeNull();
  });
});
