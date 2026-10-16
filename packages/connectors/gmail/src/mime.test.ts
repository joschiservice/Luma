import { describe, expect, it } from 'vitest';

import { composeMessage, encodeRaw, encodeWords } from './compose.js';
import { htmlToText } from './html.js';
import {
  decodeWords,
  findPart,
  maxTextLength,
  parseAddressList,
  parseMessage,
} from './mime.js';
import type { GmailMessage } from './schemas.js';

const b64 = (value: string | Buffer) =>
  Buffer.from(value).toString('base64url');

const headers = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

function message(payload: GmailMessage['payload'], labelIds = ['INBOX']) {
  return {
    id: 'm1',
    threadId: 't1',
    labelIds,
    internalDate: String(Date.parse('2026-10-02T08:00:00Z')),
    payload,
  } satisfies GmailMessage;
}

describe('parseAddressList', () => {
  it('parses names, quoted commas, comments, groups and encoded words', () => {
    expect(
      parseAddressList(
        '"Doe, Jane" <Jane@Example.com>, ops@example.com (Ops), Team: a@b.example, =?UTF-8?B?SsO8cmdlbg==?= <j@c.example>;',
      ),
    ).toEqual([
      { address: 'jane@example.com', name: 'Doe, Jane' },
      { address: 'ops@example.com', name: null },
      { address: 'a@b.example', name: null },
      { address: 'j@c.example', name: 'Jürgen' },
    ]);
  });

  it('skips entries without a valid address', () => {
    expect(parseAddressList('undisclosed-recipients:;, <>, x')).toEqual([]);
  });
});

describe('decodeWords', () => {
  it('decodes base64 and quoted-printable words in several charsets', () => {
    expect(
      decodeWords('=?iso-8859-1?Q?Gr=FC=DFe_aus?= =?UTF-8?B?S8O2bG4=?='),
    ).toBe('Grüße ausKöln');
    expect(decodeWords('plain text')).toBe('plain text');
  });
});

describe('parseMessage', () => {
  it('prefers plain text in an alternative and lists named attachments', () => {
    const parsed = parseMessage(
      message({
        partId: '',
        mimeType: 'multipart/mixed',
        headers: headers({
          From: 'Supplier <orders@supplier.example>',
          To: 'ops@shop.example',
          Cc: 'a@shop.example, b@shop.example',
          'Reply-To': 'reply@supplier.example',
          Subject: '=?UTF-8?Q?Best=C3=A4tigung?= PO-1001',
          Date: 'Thu, 01 Oct 2026 10:00:00 +0200',
          'Message-ID': '<abc@supplier.example>',
          'In-Reply-To': '<prev@shop.example>',
          References: '<root@shop.example> <prev@shop.example>',
          'Delivered-To': 'orders@shop.example',
        }),
        parts: [
          {
            partId: '0',
            mimeType: 'multipart/alternative',
            parts: [
              {
                partId: '0.0',
                mimeType: 'text/plain',
                headers: headers({
                  'Content-Type': 'text/plain; charset="iso-8859-1"',
                }),
                body: {
                  size: 5,
                  data: b64(Buffer.from('Gr\xfc\xdfe\r\n', 'latin1')),
                },
              },
              {
                partId: '0.1',
                mimeType: 'text/html',
                body: { size: 5, data: b64('<p>HTML</p>') },
              },
            ],
          },
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'PO-1001.pdf',
            body: { attachmentId: 'ATT1', size: 1234 },
          },
          {
            partId: '2',
            mimeType: 'image/png',
            filename: '',
            headers: headers({ 'Content-Disposition': 'inline' }),
            body: { attachmentId: 'IMG', size: 99 },
          },
        ],
      }),
      'ops@shop.example',
      new Map([['Label_1', 'Luma']]),
    );
    expect(parsed).toMatchObject({
      id: 'm1',
      threadId: 't1',
      rfcMessageId: 'abc@supplier.example',
      inReplyTo: 'prev@shop.example',
      references: ['root@shop.example', 'prev@shop.example'],
      direction: 'inbound',
      from: { address: 'orders@supplier.example', name: 'Supplier' },
      to: [{ address: 'ops@shop.example', name: null }],
      cc: [
        { address: 'a@shop.example', name: null },
        { address: 'b@shop.example', name: null },
      ],
      replyTo: [{ address: 'reply@supplier.example', name: null }],
      deliveredTo: ['orders@shop.example'],
      subject: 'Bestätigung PO-1001',
      text: 'Grüße\n',
      truncated: false,
      sentAt: '2026-10-01T08:00:00.000Z',
      receivedAt: '2026-10-02T08:00:00.000Z',
      labels: ['INBOX'],
      attachments: [
        {
          partId: '1',
          filename: 'PO-1001.pdf',
          mimeType: 'application/pdf',
          size: 1234,
        },
      ],
    });
  });

  it('converts HTML-only bodies, marks sent mail outbound and caps long text', () => {
    const parsed = parseMessage(
      message(
        {
          mimeType: 'text/html',
          headers: headers({
            From: 'Ops <OPS@shop.example>',
            Date: 'not a date',
          }),
          body: {
            data: b64(`<p>${'x'.repeat(maxTextLength + 10)}</p>`),
          },
        },
        ['SENT', 'Label_1'],
      ),
      'ops@shop.example',
      new Map([['Label_1', 'Luma']]),
    );
    expect(parsed.direction).toBe('outbound');
    expect(parsed.sentAt).toBe(parsed.receivedAt);
    expect(parsed.text).toHaveLength(maxTextLength);
    expect(parsed.truncated).toBe(true);
    expect(parsed.labels).toEqual(['SENT', 'Luma']);
  });

  it('finds attachment parts by their stable part ID', () => {
    const payload = {
      partId: '',
      mimeType: 'multipart/mixed',
      parts: [{ partId: '1', filename: 'a.csv', body: { attachmentId: 'X' } }],
    };
    expect(findPart(payload, '1')?.filename).toBe('a.csv');
    expect(findPart(payload, 'root')).toBe(payload);
    expect(findPart(payload, '9')).toBeNull();
  });
});

describe('htmlToText', () => {
  it('keeps text and structure but drops markup, scripts and styles', () => {
    expect(
      htmlToText(
        '<html><head><title>T</title><style>p{}</style></head><body><p>Hello&nbsp;<b>Jane</b>,</p><script>alert(1)</script><ul><li>One &amp; two</li><li>&#252;&#x00DF;</li></ul>Line<br>break &lt;tag&gt;</body></html>',
      ),
    ).toBe('Hello Jane,\n\n- One & two\n- üß\n\nLine\nbreak <tag>');
  });
});

describe('composeMessage', () => {
  const base = {
    from: { address: 'ops@shop.example', name: 'Shop Ops' },
    to: [{ address: 'orders@supplier.example', name: 'Müller, Hans' }],
    cc: [{ address: 'cc@supplier.example', name: 'Doe, "J"' }],
    subject: 'Re: Bestätigung PO-1001',
    text: 'Hallo,\nwir bestätigen.\n',
    messageId: 'luma.0b5c@shop.example',
    inReplyTo: 'abc@supplier.example',
    references: ['root@shop.example', 'abc@supplier.example'],
    date: new Date('2026-10-02T08:00:00Z'),
  };

  it('builds a UTF-8 plain text message that parses back', () => {
    const raw = composeMessage(base);
    expect(raw).toContain('From: Shop Ops <ops@shop.example>\r\n');
    expect(raw).toContain('Cc: "Doe, \\"J\\"" <cc@supplier.example>\r\n');
    expect(raw).toContain('Message-ID: <luma.0b5c@shop.example>\r\n');
    expect(raw).toContain('In-Reply-To: <abc@supplier.example>\r\n');
    expect(raw).toContain(
      'References: <root@shop.example>\r\n <abc@supplier.example>\r\n',
    );
    expect(raw).toContain('Date: Fri, 02 Oct 2026 08:00:00 +0000\r\n');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8\r\n');

    const [head, body] = raw.split('\r\n\r\n');
    const unfolded = head!.replace(/\r\n /g, ' ');
    const header = (name: string) =>
      new RegExp(`^${name}: (.*)$`, 'm').exec(unfolded)?.[1] ?? '';
    expect(decodeWords(header('Subject'))).toBe(base.subject);
    expect(parseAddressList(header('To'))).toEqual([
      { address: 'orders@supplier.example', name: 'Müller, Hans' },
    ]);
    expect(Buffer.from(body!, 'base64').toString('utf8')).toBe(
      'Hallo,\r\nwir bestätigen.\r\n',
    );
    expect(Buffer.from(encodeRaw(raw), 'base64url').toString()).toBe(raw);
  });

  it.each([
    { subject: 'Hi\r\nBcc: x@evil.example' },
    { to: [{ address: 'a@b.example>\r\nBcc: x@evil.example', name: null }] },
    { to: [{ address: 'a@b.example', name: 'A\nB' }] },
    { messageId: 'no-domain' },
    { inReplyTo: 'a>b@c' },
    { to: [], cc: [] },
  ])('rejects header injection and invalid identifiers: %j', (patch) => {
    expect(() => composeMessage({ ...base, ...patch })).toThrow();
  });

  it('splits long non-ASCII header text into short encoded words', () => {
    const words = encodeWords('ä'.repeat(100)).split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(words.join(' '))).toBe('ä'.repeat(100));
  });
});

describe('supplier purchasing mail', () => {
  it('preserves binary PDF bytes in a multipart send and rejects attachment header injection', () => {
    const bytes = Buffer.from([37, 80, 68, 70, 0, 255, 1]);
    const input = {
      from: { address: 'ops@shop.example', name: null },
      to: [{ address: 'sales@supplier.example', name: null }],
      cc: [],
      subject: 'Purchase order',
      text: 'Please confirm.',
      messageId: 'luma.test@shop.example',
      inReplyTo: null,
      references: [],
      date: new Date('2026-10-01T00:00:00Z'),
      attachments: [
        {
          filename: 'order.pdf',
          mimeType: 'application/pdf',
          base64: bytes.toString('base64'),
        },
      ],
    };
    const raw = composeMessage(input);
    expect(raw).toContain('Content-Type: multipart/mixed;');
    expect(raw).toContain(
      'Content-Disposition: attachment; filename="order.pdf"',
    );
    const encoded =
      /Content-Disposition: attachment;[^]*?\r\n\r\n([^]*?)\r\n--/.exec(
        raw,
      )?.[1];
    expect(Buffer.from(encoded ?? '', 'base64')).toEqual(bytes);
    expect(() =>
      composeMessage({
        ...input,
        attachments: [
          {
            ...input.attachments[0]!,
            filename: 'order.pdf"\r\nBcc: evil@example.com',
          },
        ],
      }),
    ).toThrow();
  });
  it('only treats a structured permanent DSN with the original message and recipient as a bounce', () => {
    const report =
      'Original-Message-ID: <luma.test@shop.example>\r\n\r\nFinal-Recipient: rfc822; sales@supplier.example\r\nAction: failed\r\nStatus: 5.1.1\r\n';
    const payload = {
      mimeType: 'multipart/report',
      headers: headers({
        'Content-Type': 'multipart/report; report-type=delivery-status',
        From: 'mailer-daemon@mail.example',
        To: 'ops@shop.example',
      }),
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Delivery failed') } },
        { mimeType: 'message/delivery-status', body: { data: b64(report) } },
      ],
    };
    expect(
      parseMessage(message(payload), 'ops@shop.example').deliveryFailure,
    ).toEqual({
      originalMessageId: 'luma.test@shop.example',
      recipient: 'sales@supplier.example',
      status: '5.1.1',
    });
    expect(
      parseMessage(
        message({
          ...payload,
          parts: [{ mimeType: 'text/plain', body: { data: b64(report) } }],
        }),
        'ops@shop.example',
      ).deliveryFailure,
    ).toBeUndefined();
    expect(
      parseMessage(
        message({
          ...payload,
          parts: [
            {
              mimeType: 'message/delivery-status',
              body: {
                data: b64(
                  report.replace('5.1.1', '4.2.0').replace('failed', 'delayed'),
                ),
              },
            },
          ],
        }),
        'ops@shop.example',
      ).deliveryFailure,
    ).toBeUndefined();
  });
});

describe('untrusted HTML limits', () => {
  it('retains source truncation when hidden content hides a later correction', () => {
    const html =
      'Confirmed: 10 units<!--' +
      'x'.repeat(2_000_000) +
      '-->Correction: cancel that order';
    const parsed = parseMessage(
      message({ mimeType: 'text/html', body: { data: b64(html) } }),
      'ops@shop.example',
    );
    expect(parsed.text).toBe('Confirmed: 10 units');
    expect(parsed.truncated).toBe(true);
  });

  it('does not trust a forged From header as provider sent evidence', () => {
    const parsed = parseMessage(
      message({
        mimeType: 'text/plain',
        headers: headers({ From: 'ops@shop.example' }),
        body: { data: b64('Forged') },
      }),
      'ops@shop.example',
    );
    expect(parsed.providerSent).toBe(false);
  });
});
