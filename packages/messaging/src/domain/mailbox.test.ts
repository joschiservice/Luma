import { describe, expect, it } from 'vitest';

import type { Mailbox, MailboxRule } from './mailbox.js';
import {
  backoffMs,
  blockingFailure,
  defaultSettings,
  mailboxFilter,
  mailboxState,
  planScan,
} from './mailbox.js';

const rule = (
  id: string,
  kind: MailboxRule['kind'],
  value: string,
  backfilledAt: string | null = '2026-10-01T00:00:00.000Z',
): MailboxRule => ({
  id,
  connectionId: 'mailbox',
  kind,
  value,
  party: { kind: 'other' },
  backfilledAt,
  createdBy: 'user',
  createdAt: '2026-10-01T00:00:00.000Z',
});

const now = new Date('2026-10-11T12:00:00.000Z');

describe('mailbox filter', () => {
  it('unions rules by kind, lower-cases addresses and always includes sent replies', () => {
    expect(
      mailboxFilter([
        rule('1', 'sender_domain', 'Supplier.Example'),
        rule('2', 'sender_address', 'anna@x.example'),
        rule('3', 'recipient_address', 'orders@shop.example'),
        rule('4', 'label', 'Suppliers'),
        rule('5', 'sender_domain', 'supplier.example'),
      ]),
    ).toEqual({
      senderDomains: ['supplier.example'],
      senderAddresses: ['anna@x.example'],
      recipientAddresses: ['orders@shop.example'],
      labels: ['Suppliers'],
      includeSent: true,
    });
  });
});

describe('scan planning', () => {
  const settings = defaultSettings;

  it('reads the backfill window first, then from the covered time with an overlap', () => {
    const rules = [rule('1', 'sender_domain', 'a.example', null)];
    expect(planScan({ cursor: {}, settings }, rules, now)).toMatchObject({
      kind: 'initial',
      since: '2026-09-11T12:00:00.000Z',
      ruleIds: ['1'],
      page: null,
    });
    expect(
      planScan(
        {
          cursor: { coveredUntil: '2026-10-11T11:00:00.000Z' },
          settings,
        },
        [rule('1', 'sender_domain', 'a.example')],
        now,
      ),
    ).toMatchObject({
      kind: 'incremental',
      since: '2026-10-11T10:50:00.000Z',
    });
  });

  it('backfills only new rules and restarts scans whose rules were removed', () => {
    const cursor = { coveredUntil: '2026-10-11T11:00:00.000Z' };
    const rules = [
      rule('1', 'sender_domain', 'a.example'),
      rule('2', 'sender_domain', 'b.example', null),
    ];
    expect(planScan({ cursor, settings }, rules, now)).toMatchObject({
      kind: 'backfill',
      ruleIds: ['2'],
      since: '2026-09-11T12:00:00.000Z',
    });
    const scan = {
      kind: 'incremental' as const,
      since: 'x',
      startedAt: 'y',
      ruleIds: ['1', 'gone'],
      page: 'next',
    };
    expect(
      planScan({ cursor: { ...cursor, scan }, settings }, rules, now),
    ).not.toBe(scan);
    const kept = { ...scan, ruleIds: ['1'] };
    expect(
      planScan({ cursor: { ...cursor, scan: kept }, settings }, rules, now),
    ).toBe(kept);
    expect(planScan({ cursor, settings }, [], now)).toBeNull();
  });
});

describe('failures', () => {
  it('backs off exponentially to an hour and honours provider advice', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(1, 90_000)).toBe(90_000);
  });

  it('blocks only on failures a person must fix', () => {
    expect(blockingFailure('authentication')).toBe('authentication');
    expect(blockingFailure('permission_denied')).toBe('permission_denied');
    expect(blockingFailure('rate_limited')).toBeNull();
    expect(blockingFailure('unavailable')).toBeNull();
  });
});

describe('mailbox state', () => {
  const base: Pick<
    Mailbox,
    'paused' | 'blocked' | 'attempts' | 'lastError' | 'cursor'
  > = {
    paused: false,
    blocked: null,
    attempts: 0,
    lastError: null,
    cursor: { coveredUntil: '2026-10-11T11:00:00.000Z' },
  };
  const active = { status: 'active' as const, canRead: true };
  const rules = [{ backfilledAt: '2026-10-01T00:00:00.000Z' }];

  it('explains why reading is held up', () => {
    expect(mailboxState({ ...base, paused: true }, rules, active).state).toBe(
      'paused',
    );
    expect(mailboxState(base, rules, { ...active, status: 'revoked' })).toEqual(
      {
        state: 'blocked',
        reason: expect.stringContaining('Reconnect'),
      },
    );
    expect(
      mailboxState({ ...base, blocked: 'authentication' }, rules, active).state,
    ).toBe('blocked');
    expect(mailboxState(base, [], active).state).toBe('needs_rules');
    expect(
      mailboxState(
        { ...base, attempts: 2, lastError: 'rate_limited' },
        rules,
        active,
      ),
    ).toEqual({
      state: 'retrying',
      reason: expect.stringContaining('slow down'),
    });
    expect(mailboxState(base, [{ backfilledAt: null }], active).state).toBe(
      'syncing',
    );
    expect(mailboxState(base, rules, active)).toEqual({
      state: 'current',
      reason: null,
    });
  });
});
