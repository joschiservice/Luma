import { describe, expect, it } from 'vitest';

import { buildQuery, type MailboxFilter, matchesFilter } from './query.js';

const empty: MailboxFilter = {
  senderDomains: [],
  senderAddresses: [],
  recipientAddresses: [],
  labels: [],
  includeSent: true,
};

const since = '2026-10-01T00:00:00.000Z';
const epoch = Date.parse(since) / 1000 - 1;

describe('buildQuery', () => {
  it('returns no query for an empty filter', () => {
    expect(buildQuery(empty, since)).toBeNull();
    expect(buildQuery({ ...empty, includeSent: false }, since)).toBeNull();
  });

  it('combines every condition with OR and bounds the receipt window', () => {
    expect(
      buildQuery(
        {
          senderDomains: ['supplier.example'],
          senderAddresses: ['jane@other.example'],
          recipientAddresses: ['orders@shop.example'],
          labels: ['Luma Inbox'],
          includeSent: true,
        },
        since,
      ),
    ).toBe(
      '(from:(supplier.example OR jane@other.example) OR to:(orders@shop.example) OR cc:(orders@shop.example) OR deliveredto:(orders@shop.example) OR label:"Luma Inbox" OR (in:sent to:(supplier.example OR jane@other.example)) OR (in:sent cc:(supplier.example OR jane@other.example))) after:' +
        epoch,
    );
  });

  it('omits sent conditions when the mailbox replies are excluded', () => {
    expect(
      buildQuery(
        { ...empty, senderDomains: ['a.example'], includeSent: false },
        since,
      ),
    ).toBe(`(from:(a.example)) after:${epoch}`);
  });

  it.each([
    { senderDomains: ['a.example) OR (b'] },
    { senderDomains: ['A.example'] },
    { senderAddresses: ['x"y@a.example'] },
    { senderAddresses: ['a{b}@a.example'] },
    { recipientAddresses: ['no-at-sign'] },
    { labels: ['say "hi"'] },
    { labels: ['back\\slash'] },
  ])('rejects values that could change the query: %j', (patch) => {
    expect(() => buildQuery({ ...empty, ...patch }, since)).toThrow();
  });
});

describe('matchesFilter', () => {
  const filter: MailboxFilter = {
    ...empty,
    senderDomains: ['supplier.example'],
    recipientAddresses: ['orders@shop.example'],
    labels: ['Luma'],
  };
  const subject = {
    from: 'someone@else.example',
    to: ['ops@shop.example'],
    cc: [],
    deliveredTo: [],
    labels: [],
    outbound: false,
  };

  it('matches sender domains and their subdomains, but not lookalikes', () => {
    expect(
      matchesFilter(filter, { ...subject, from: 'a@supplier.example' }),
    ).toBe(true);
    expect(
      matchesFilter(filter, { ...subject, from: 'a@eu.supplier.example' }),
    ).toBe(true);
    expect(
      matchesFilter(filter, { ...subject, from: 'a@supplier.example.evil' }),
    ).toBe(false);
    expect(
      matchesFilter(filter, { ...subject, from: 'a@notsupplier.example' }),
    ).toBe(false);
  });

  it('matches recipients, delivered-to aliases and labels', () => {
    expect(
      matchesFilter(filter, { ...subject, cc: ['orders@shop.example'] }),
    ).toBe(true);
    expect(
      matchesFilter(filter, {
        ...subject,
        deliveredTo: ['orders@shop.example'],
      }),
    ).toBe(true);
    expect(matchesFilter(filter, { ...subject, labels: ['luma'] })).toBe(true);
    expect(matchesFilter(filter, subject)).toBe(false);
  });

  it('matches replies the mailbox sent to a listed party', () => {
    const reply = {
      ...subject,
      from: 'ops@shop.example',
      to: ['a@supplier.example'],
      outbound: true,
    };
    expect(matchesFilter(filter, reply)).toBe(true);
    expect(matchesFilter({ ...filter, includeSent: false }, reply)).toBe(false);
    expect(matchesFilter(filter, { ...reply, outbound: false })).toBe(false);
  });
});
