import { createMemoryStore, createTransport } from '@luma/simulator-core';
import { describe, expect, it } from 'vitest';

import { csv, gmail, type GmailContext, textPdf } from './index.js';

const start = Date.parse('2026-10-01T08:00:00Z');

function createContext(indexLagMs = 0): GmailContext {
  return {
    store: createMemoryStore(),
    now: start,
    wallTime: start,
    instance: 'gmail',
    config: {
      address: 'einkauf@luma-goods.example',
      name: 'Luma Goods Einkauf',
    },
    indexLagMs,
    notify: () => {},
  };
}

const api = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface Part {
  partId: string;
  mimeType: string;
  filename: string;
  headers: { name: string; value: string }[];
  body: { size: number; data: string; attachmentId: string };
  parts: Part[];
}

/** The response fields these tests read; each response carries only some of them. */
interface Body {
  error: { code: number; status: string };
  labels: { id: string; name: string; type: string }[];
  messages: { id: string; threadId: string; payload: Part }[];
  resultSizeEstimate: number;
  nextPageToken: string;
  id: string;
  threadId: string;
  labelIds: string[];
  payload: Part;
  raw: string;
  data: string;
  size: number;
  access_token: string;
  refresh_token: string;
  id_token: string;
  scope: string;
}

function client(context: GmailContext, token: string | null = 'ya29.test') {
  const fetch = createTransport((request) => gmail.handle(context, request));

  return async (path: string, init: RequestInit = {}) => {
    const response = await fetch(
      path.startsWith('https://') ? path : `${api}/${path}`,
      {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      },
    );

    return { status: response.status, body: (await response.json()) as Body };
  };
}

const raw = (lines: string[]) =>
  Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');

async function supplierThread(context: GmailContext) {
  await gmail.command(context, {
    kind: 'seed-mailbox',
    address: 'einkauf@luma-goods.example',
    name: 'Luma Goods Einkauf',
    labels: ['Lieferanten'],
  });
  const first = await gmail.command(context, {
    kind: 'deliver',
    from: { address: 'orders1@supplier.example', name: 'Nordwind Textil' },
    subject: 'Auftragsbestätigung BE-00042',
    text: 'We confirm BE-00042: 100 x SKU-1.',
    messageId: '<confirm-42@supplier.example>',
    labels: ['Lieferanten'],
    attachments: [
      {
        filename: 'AB-BE-00042.pdf',
        mimeType: 'application/pdf',
        base64: textPdf(['Order confirmation BE-00042', '100 x SKU-1']),
      },
    ],
  });
  context.now += 60_000;
  await gmail.command(context, {
    kind: 'deliver',
    from: { address: 'kunde.1@customer.example' },
    subject: 'Where is my order #DE1001?',
    text: 'Hallo, meine Bestellung #DE1001 ist noch nicht da.',
  });

  return first;
}

describe('Gmail API', () => {
  it('requires a bearer token and answers in Google’s error shape', async () => {
    const context = createContext();
    const response = await client(context, null)('profile');
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: 401,
      status: 'UNAUTHENTICATED',
    });
    expect((await client(context)('messages/unknown')).body.error.code).toBe(
      404,
    );
  });

  it('reports the mailbox profile and labels', async () => {
    const context = createContext();
    await supplierThread(context);
    const call = client(context);
    expect((await call('profile')).body).toMatchObject({
      emailAddress: 'einkauf@luma-goods.example',
      messagesTotal: 2,
      threadsTotal: 2,
    });
    const labels = (await call('labels')).body.labels as {
      id: string;
      name: string;
    }[];
    expect(labels).toContainEqual(
      expect.objectContaining({
        id: 'Label_1',
        name: 'Lieferanten',
        type: 'user',
      }),
    );
    expect(
      (
        await call(
          'https://gmail.googleapis.com/gmail/v1/users/other@example.com/profile',
        )
      ).status,
    ).toBe(403);
  });

  it('searches with the operators Luma’s query builder generates', async () => {
    const context = createContext();
    await supplierThread(context);
    const call = client(context);
    const search = async (q: string) =>
      ((await call(`messages?q=${encodeURIComponent(q)}`)).body.messages ?? [])
        .length;
    const after = Math.floor(start / 1000) - 600;
    expect(
      await search(`(from:(@supplier.example OR x@y.example)) after:${after}`),
    ).toBe(1);
    expect(await search('from:@example')).toBe(2);
    expect(await search('from:@other.example')).toBe(0);
    expect(await search('label:"Lieferanten"')).toBe(1);
    expect(await search('label:lieferanten -from:@customer.example')).toBe(1);
    expect(await search(`after:${Math.floor(start / 1000) + 30}`)).toBe(1);
    expect(await search('rfc822msgid:confirm-42@supplier.example')).toBe(1);
    expect(await search('in:sent')).toBe(0);
    expect(
      await search('{from:kunde.1@customer.example from:nobody@x.example}'),
    ).toBe(1);
    expect(await search('has:attachment filename:pdf')).toBe(1);
    expect((await call('messages?q=from:(@a OR')).status).toBe(400);
    expect((await call('messages?maxResults=501')).status).toBe(400);
  });

  it('pages newest first with stable page tokens', async () => {
    const context = createContext();
    for (let index = 0; index < 5; index++) {
      context.now = start + index * 1000;
      await gmail.command(context, {
        kind: 'deliver',
        from: { address: `s${index}@supplier.example` },
        subject: `Message ${index}`,
        text: 'Hello',
      });
    }
    const call = client(context);
    const first = (await call('messages?maxResults=2')).body;
    expect(first.resultSizeEstimate).toBe(5);
    // A message arriving between pages does not shift the next page.
    context.now = start + 10_000;
    await gmail.command(context, {
      kind: 'deliver',
      from: { address: 'late@supplier.example' },
      subject: 'Late',
      text: 'Hello',
    });
    const second = (
      await call(`messages?maxResults=2&pageToken=${first.nextPageToken}`)
    ).body;
    const third = (
      await call(`messages?maxResults=2&pageToken=${second.nextPageToken}`)
    ).body;
    const subjects = async (ids: { id: string }[]) =>
      Promise.all(
        ids.map(
          async ({ id }) =>
            (
              await call(
                `messages/${id}?format=metadata&metadataHeaders=Subject`,
              )
            ).body.payload.headers[0]?.value,
        ),
      );
    expect([
      ...(await subjects(first.messages)),
      ...(await subjects(second.messages)),
      ...(await subjects(third.messages)),
    ]).toEqual([
      'Message 4',
      'Message 3',
      'Message 2',
      'Message 1',
      'Message 0',
    ]);
    expect(third.nextPageToken).toBeUndefined();
  });

  it('returns full messages with a part tree and attachment bodies', async () => {
    const context = createContext();
    const delivered = await supplierThread(context);
    if (delivered.kind !== 'message') throw new Error('Expected a message');
    const call = client(context);
    const message = (await call(`messages/${delivered.id}?format=full`)).body;
    expect(message).toMatchObject({
      id: delivered.id,
      threadId: delivered.id,
      labelIds: ['INBOX', 'UNREAD', 'Label_1'],
      internalDate: String(start),
      payload: { mimeType: 'multipart/mixed' },
    });
    const headers = Object.fromEntries(
      (message.payload.headers as { name: string; value: string }[]).map(
        (h) => [h.name, h.value],
      ),
    );
    expect(headers['Message-ID']).toBe('<confirm-42@supplier.example>');
    expect(headers.From).toBe('Nordwind Textil <orders1@supplier.example>');
    const [text, pdf] = message.payload.parts as [Part, Part];
    expect(Buffer.from(text.body.data, 'base64url').toString()).toBe(
      'We confirm BE-00042: 100 x SKU-1.',
    );
    expect(pdf).toMatchObject({
      filename: 'AB-BE-00042.pdf',
      mimeType: 'application/pdf',
    });
    const content = (
      await call(
        `messages/${delivered.id}/attachments/${pdf.body.attachmentId}`,
      )
    ).body;
    const bytes = Buffer.from(content.data, 'base64url');
    expect(content.size).toBe(bytes.length);
    expect(bytes.toString('latin1')).toMatch(
      /^%PDF-1\.4[\s\S]*\(Order confirmation BE-00042\) Tj/,
    );
    expect(
      (await call(`messages/${delivered.id}/attachments/unknown`)).status,
    ).toBe(404);
    const rawMessage = (await call(`messages/${delivered.id}?format=raw`)).body
      .raw;
    expect(Buffer.from(rawMessage, 'base64url').toString()).toContain(
      'Content-Disposition: attachment; filename="AB-BE-00042.pdf"',
    );
  });

  it('sends replies into the thread only when references and subject match', async () => {
    const context = createContext();
    const delivered = await supplierThread(context);
    if (delivered.kind !== 'message') throw new Error('Expected a message');
    const call = client(context);
    const reply = [
      'To: Nordwind Textil <orders1@supplier.example>',
      'Subject: Re: Auftragsbestätigung BE-00042',
      'Message-ID: <luma.out-1@luma-goods.example>',
      'In-Reply-To: <confirm-42@supplier.example>',
      'References: <confirm-42@supplier.example>',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Thanks, we expect the goods on Friday.',
    ];
    const sent = await call('messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: raw(reply), threadId: delivered.threadId }),
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({
      threadId: delivered.threadId,
      labelIds: ['SENT'],
    });
    const thread = (await call(`threads/${delivered.threadId}`)).body;
    expect(thread.messages).toHaveLength(2);
    const sentHeaders = thread.messages[1]!.payload.headers as {
      name: string;
      value: string;
    }[];
    expect(sentHeaders).toContainEqual({
      name: 'From',
      value: 'Luma Goods Einkauf <einkauf@luma-goods.example>',
    });
    expect(
      (await call('messages?q=rfc822msgid:luma.out-1@luma-goods.example')).body
        .messages,
    ).toEqual([{ id: sent.body.id, threadId: delivered.threadId }]);

    // A different subject starts a new thread, as in Gmail.
    const other = await call('messages/send', {
      method: 'POST',
      body: JSON.stringify({
        raw: raw([
          ...reply.slice(0, 1),
          'Subject: Something else',
          'Message-ID: <luma.out-2@luma-goods.example>',
          ...reply.slice(3),
        ]),
        threadId: delivered.threadId,
      }),
    });
    expect(other.body.threadId).toBe(other.body.id);
    // Sending the same message again sends it again; the caller must prevent duplicates.
    const again = await call('messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: raw(reply), threadId: delivered.threadId }),
    });
    expect(again.body.id).not.toBe(sent.body.id);
    expect(
      (await call('messages?q=rfc822msgid:luma.out-1@luma-goods.example')).body
        .resultSizeEstimate,
    ).toBe(2);
    expect(
      (
        await call('messages/send', {
          method: 'POST',
          body: JSON.stringify({
            raw: raw(['Subject: x', '', 'no recipient']),
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('messages/send', {
          method: 'POST',
          body: JSON.stringify({ raw: raw(reply), threadId: 'ffff' }),
        })
      ).status,
    ).toBe(404);
  });

  it('marks sends as committed and hides fresh messages from search during index lag', async () => {
    const context = createContext(3_000);
    const response = await gmail.handle(context, {
      url: `${api}/messages/send`,
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        raw: raw(['To: a@supplier.example', 'Subject: Hi', '', 'Hello']),
      }),
    });
    expect(response.committed).toBe(true);
    const id = (response.body as { id: string }).id;
    const call = client(context);
    expect(
      (await call('messages?q=to:a@supplier.example')).body.resultSizeEstimate,
    ).toBe(0);
    expect((await call(`messages/${id}`)).status).toBe(200);
    context.now += 3_000;
    expect(
      (await call('messages?q=to:a@supplier.example')).body.resultSizeEstimate,
    ).toBe(1);
  });

  it('renews and stops watches', async () => {
    const context = createContext();
    const call = client(context);
    const watch = await call('watch', {
      method: 'POST',
      body: JSON.stringify({
        topicName: 'projects/luma/topics/gmail',
        labelIds: ['INBOX'],
      }),
    });
    expect(watch.body).toMatchObject({
      historyId: '1000',
      expiration: String(start + 7 * 86_400_000),
    });
    expect(
      (
        await call('watch', {
          method: 'POST',
          body: JSON.stringify({ topicName: 'gmail' }),
        })
      ).status,
    ).toBe(400);
    expect((await call('stop', { method: 'POST' })).status).toBe(200);
  });

  it('identifies operations for fault rules and charges Gmail quota units', () => {
    const request = (url: string, method = 'GET') => ({
      url,
      method,
      headers: {},
      body: null,
    });
    expect(gmail.identify(request(`${api}/messages?q=x`))).toMatchObject({
      operation: 'messages.read',
      write: false,
    });
    expect(
      gmail.identify(request(`${api}/messages/abc/attachments/def`)),
    ).toMatchObject({
      operation: 'message-attachments.read',
      resource: 'abc',
    });
    expect(gmail.identify(request(`${api}/threads/t1`)).operation).toBe(
      'message-threads.read',
    );
    expect(
      gmail.identify(request(`${api}/messages/send`, 'POST')),
    ).toMatchObject({ operation: 'messages.send', write: true });
    expect(
      gmail.identify(request('https://oauth2.googleapis.com/token', 'POST'))
        .operation,
    ).toBe('oauth.token');
    expect(gmail.rateLimit!.cost(request(`${api}/messages/send`, 'POST'))).toBe(
      100,
    );
    expect(
      gmail.drift({ status: 200, headers: {}, body: { messages: [] } }).body,
    ).toEqual({ messageItems: [] });
  });
});

describe('Google OAuth', () => {
  const token = (context: GmailContext, body: Record<string, string>) =>
    client(context, null)('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

  it('exchanges codes and refresh tokens', async () => {
    const context = createContext();
    const code = await token(context, {
      grant_type: 'authorization_code',
      code: 'sim-code',
      client_id: 'client',
      client_secret: 'secret',
      redirect_uri: 'https://luma.example/api/v1/gmail/callback',
      code_verifier: 'verifier',
    });
    expect(code.status).toBe(200);
    expect(code.body).toMatchObject({ expires_in: 3599, token_type: 'Bearer' });
    expect(code.body.scope).toContain(
      'https://www.googleapis.com/auth/gmail.send',
    );
    expect(code.body.refresh_token).toMatch(/^1\/\//);
    const claims = JSON.parse(
      Buffer.from(code.body.id_token.split('.')[1]!, 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      email: 'einkauf@luma-goods.example',
      aud: 'client',
    });
    const refreshed = await token(context, {
      grant_type: 'refresh_token',
      refresh_token: code.body.refresh_token,
      client_id: 'client',
    });
    expect(refreshed.body.access_token).not.toBe(code.body.access_token);
    expect(refreshed.body.refresh_token).toBeUndefined();
    expect(
      (await token(context, { grant_type: 'password', client_id: 'client' }))
        .body.error,
    ).toBe('unsupported_grant_type');
    expect(
      (
        await token(context, {
          grant_type: 'refresh_token',
          client_id: 'client',
        })
      ).status,
    ).toBe(400);
  });

  it('rejects revoked grants with invalid_grant', () => {
    const response = gmail.unauthorized({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      headers: {},
      body: null,
    });
    expect(response).toMatchObject({
      status: 400,
      body: { error: 'invalid_grant' },
    });
  });
});

describe('Mailbox commands', () => {
  it('threads replies, keeps delivery idempotent per Message-ID and validates the sender', async () => {
    const context = createContext();
    const first = await supplierThread(context);
    if (first.kind !== 'message') throw new Error('Expected a message');
    const reply = await gmail.command(context, {
      kind: 'deliver',
      from: { address: 'orders1@supplier.example' },
      threadOf: '<confirm-42@supplier.example>',
      text: 'Die restlichen 40 Stück folgen nächste Woche.',
      messageId: 'split-42@supplier.example',
    });
    expect(reply).toMatchObject({ threadId: first.threadId, created: true });
    const repeated = await gmail.command(context, {
      kind: 'deliver',
      from: { address: 'orders1@supplier.example' },
      threadOf: first.id,
      text: 'Again',
      messageId: '<split-42@supplier.example>',
    });
    expect(repeated).toMatchObject({ created: false });
    if (reply.kind !== 'message') throw new Error('Expected a message');
    const message = (await client(context)(`messages/${reply.id}`)).body;
    const subject = (
      message.payload.headers as { name: string; value: string }[]
    ).find((h) => h.name === 'Subject');
    expect(subject?.value).toBe(
      '=?UTF-8?B?UmU6IEF1ZnRyYWdzYmVzdMOkdGlndW5nIEJFLTAwMDQy?=',
    );
    await expect(
      gmail.command(context, {
        kind: 'deliver',
        from: { address: 'nobody' },
        text: 'x',
      }),
    ).rejects.toThrow('email address');
    await expect(
      gmail.command(context, {
        kind: 'deliver',
        from: { address: 'a@b.example' },
        threadOf: 'missing',
        text: 'x',
      }),
    ).rejects.toThrow('not found');
  });

  it('builds deterministic CSV and PDF documents', () => {
    expect(
      Buffer.from(
        csv([
          ['SKU', 'Menge'],
          ['SKU-1', 60],
        ]),
        'base64',
      ).toString(),
    ).toBe('SKU;Menge\r\nSKU-1;60\r\n');
    const pdf = Buffer.from(
      textPdf(['Lieferschein (Teil 1) – 60 €']),
      'base64',
    ).toString('latin1');
    expect(pdf).toContain('(Lieferschein \\(Teil 1\\) \x96 60 \x80) Tj');
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    expect(textPdf(['a'])).toBe(textPdf(['a']));
  });
});

describe('supplier order delivery failures', () => {
  it('emits a permanent MIME report tied to an outgoing message and keeps its thread', async () => {
    const context = createContext();
    const call = client(context);
    const original = await gmail.command(context, {
      kind: 'deliver',
      from: { address: context.config.address },
      to: [{ address: 'sales@supplier.example' }],
      subject: 'Purchase order PO-1001',
      text: 'Please confirm.',
      messageId: 'luma.purchase@luma-goods.example',
    });
    if (original.kind !== 'message') throw new Error('Expected message');
    const bounce = await gmail.command(context, {
      kind: 'bounce',
      message: original.id,
      recipient: 'sales@supplier.example',
      status: '5.1.1',
    });
    if (bounce.kind !== 'message') throw new Error('Expected bounce');
    expect(bounce.threadId).toBe(original.threadId);
    const message = (await call(`messages/${bounce.id}?format=full`)).body;
    expect(message.payload.mimeType).toBe('multipart/report');
    const report = message.payload.parts.find(
      (part) => part.mimeType === 'message/delivery-status',
    );
    expect(
      Buffer.from(report?.body.data ?? '', 'base64url').toString(),
    ).toContain('Original-Message-ID: <luma.purchase@luma-goods.example>');
    await expect(
      gmail.command(context, {
        kind: 'bounce',
        message: original.id,
        recipient: 'other@supplier.example',
        status: '5.1.1',
      }),
    ).rejects.toThrow();
  });
});
