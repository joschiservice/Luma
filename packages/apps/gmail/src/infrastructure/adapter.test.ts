import { createHash } from 'node:crypto';

import type {
  CapabilityHandler,
  ConnectorConnection,
  InvocationContext,
  MailboxFilter,
} from '@luma/connections';
import { ConnectorError } from '@luma/connections';
import { createQuotaPacer } from '@luma/connector-gmail';
import type { TenantContext } from '@luma/identity';
import { describe, expect, it, vi } from 'vitest';

import {
  createGmailConnector,
  sentEvidenceId,
  type WatchState,
} from './adapter.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const mailbox = 'ops@shop.example';
const b64 = (value: string) => Buffer.from(value).toString('base64url');

function gmailMessage(
  id: string,
  from: string,
  extra: { labels?: string[]; to?: string; parts?: unknown[] } = {},
) {
  return {
    id,
    threadId: `t-${id}`,
    historyId: '100',
    labelIds: extra.labels ?? ['INBOX'],
    internalDate: String(Date.parse('2026-10-02T08:00:00Z')),
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: extra.to ?? mailbox },
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'Message-ID', value: `<${id}@mail.example>` },
      ],
      parts: extra.parts ?? [
        {
          partId: '0',
          mimeType: 'text/plain',
          body: { data: b64(`Body ${id}`) },
        },
      ],
    },
  };
}

type Route = (url: URL, init: RequestInit | undefined) => unknown;

function fakeGmail(routes: Record<string, Route>) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      const path = url.pathname.replace('/gmail/v1/users/me/', '');
      const route = Object.entries(routes).find(([pattern]) =>
        new RegExp(`^${pattern}$`).test(path),
      );
      if (!route)
        return new Response(JSON.stringify({ error: { code: 404 } }), {
          status: 404,
        });
      const body = route[1](url, init);

      return body instanceof Response
        ? body
        : new Response(JSON.stringify(body), { status: 200 });
    },
  );

  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function connector(
  fetch: typeof globalThis.fetch,
  watch?: {
    load(): Promise<WatchState | null>;
    save(state: WatchState): Promise<void>;
  },
): ConnectorConnection {
  return createGmailConnector({
    tenantId,
    connectionId,
    emailAddress: mailbox,
    accessToken: async () => 'access-token',
    fetch,
    // Admission spacing is covered by the client tests; here it would only add real waiting.
    pacer: createQuotaPacer({ sleep: async () => {} }),
    now: () => new Date('2026-10-03T00:00:00Z'),
    ...(watch ? { watch: { topic: 'projects/p/topics/gmail', ...watch } } : {}),
  });
}

const context = (idempotencyKey?: string): InvocationContext => ({
  tenant: { tenantId } as TenantContext,
  connectionId,
  provider: 'gmail',
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

const filter: MailboxFilter = {
  senderDomains: ['supplier.example'],
  senderAddresses: [],
  recipientAddresses: [],
  labels: [],
  includeSent: true,
};

async function run<K extends keyof ConnectorConnection['capabilities']>(
  adapter: ConnectorConnection,
  capability: K,
  input: unknown,
  key?: string,
) {
  const handler = adapter.capabilities[capability] as CapabilityHandler<K>;

  return handler.parseOutput(
    await handler.run(context(key), handler.parseInput(input)),
  );
}

const labels = () => ({ labels: [{ id: 'INBOX', name: 'INBOX' }] });

describe('messages.read', () => {
  it('reads matching messages through a server-side query and drops lookalikes', async () => {
    const gmail = fakeGmail({
      messages: (url) => {
        expect(url.searchParams.get('q')).toMatch(
          /^\(from:\(supplier\.example\) OR \(in:sent to:\(supplier\.example\)\) OR \(in:sent cc:\(supplier\.example\)\)\) after:\d+$/,
        );
        expect(url.searchParams.get('maxResults')).toBe('50');

        return url.searchParams.get('pageToken')
          ? { messages: [{ id: 'c', threadId: 't-c' }] }
          : {
              messages: [
                { id: 'a', threadId: 't-a' },
                { id: 'b', threadId: 't-b' },
                { id: 'gone', threadId: 't-gone' },
              ],
              nextPageToken: 'NEXT',
            };
      },
      labels,
      'messages/a': () => gmailMessage('a', 'Jane <jane@eu.supplier.example>'),
      'messages/b': () => gmailMessage('b', 'x@supplier.example.evil'),
      'messages/c': () =>
        gmailMessage('c', mailbox, {
          labels: ['SENT'],
          to: 'jane@supplier.example',
        }),
    });
    const adapter = connector(gmail.fetch);
    const first = await run(adapter, 'messages.read', {
      filter,
      receivedSince: '2026-10-01T00:00:00Z',
      limit: 50,
    });
    expect(first.items.map((item) => item.source.externalId)).toEqual(['a']);
    expect(first.items[0]).toMatchObject({
      id: `gmail:${connectionId}:message:a`,
      source: {
        tenantId,
        connectionId,
        provider: 'gmail',
        resource: 'message',
        externalId: 'a',
        scopeKey: '',
      },
      kind: 'snapshot',
      adapterVersion: 'gmail/1',
      schemaVersion: 1,
      data: {
        thread: { externalId: 't-a', scopeKey: '' },
        rfcMessageId: 'a@mail.example',
        direction: 'inbound',
        from: { address: 'jane@eu.supplier.example', name: 'Jane' },
        text: 'Body a',
      },
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await run(adapter, 'messages.read', {
      filter,
      receivedSince: '2026-10-01T00:00:00Z',
      limit: 50,
      cursor: first.nextCursor,
    });
    expect(second.items[0]?.data).toMatchObject({ direction: 'outbound' });
    expect(second.nextCursor).toBeNull();

    // A cursor belongs to the query it was issued for.
    await expect(
      run(adapter, 'messages.read', {
        filter: { ...filter, senderDomains: ['other.example'] },
        receivedSince: '2026-10-01T00:00:00Z',
        limit: 50,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ failure: { code: 'invalid_input' } });
  });

  it('requests nothing for an empty filter', async () => {
    const gmail = fakeGmail({});
    const page = await run(connector(gmail.fetch), 'messages.read', {
      filter: { ...filter, senderDomains: [] },
      receivedSince: '2026-10-01T00:00:00Z',
      limit: 10,
    });
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      completeness: 'complete',
    });
    expect(gmail.calls).toHaveLength(0);
  });

  it('renews an expiring push registration without failing reads', async () => {
    const saved: WatchState[] = [];
    const gmail = fakeGmail({
      watch: (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          topicName: 'projects/p/topics/gmail',
          labelIds: ['INBOX', 'SENT'],
          labelFilterBehavior: 'INCLUDE',
        });

        return {
          historyId: '555',
          expiration: String(Date.parse('2026-10-10T00:00:00Z')),
        };
      },
      messages: () => ({}),
      labels,
    });
    await run(
      connector(gmail.fetch, {
        load: async () => ({
          topic: 'projects/p/topics/gmail',
          historyId: '1',
          expiresAt: '2026-10-03T12:00:00.000Z',
        }),
        save: async (state) => {
          saved.push(state);
        },
      }),
      'messages.read',
      { filter, receivedSince: '2026-10-01T00:00:00Z', limit: 10 },
    );
    expect(saved).toEqual([
      {
        topic: 'projects/p/topics/gmail',
        historyId: '555',
        expiresAt: '2026-10-10T00:00:00.000Z',
      },
    ]);

    const failing = fakeGmail({
      watch: () => new Response('{}', { status: 403 }),
      messages: () => ({}),
      labels,
    });
    await expect(
      run(
        connector(failing.fetch, {
          load: async () => null,
          save: async () => {},
        }),
        'messages.read',
        { filter, receivedSince: '2026-10-01T00:00:00Z', limit: 10 },
      ),
    ).resolves.toMatchObject({ items: [] });
  });
});

describe('message-threads.read', () => {
  it('returns every message of the thread in pages', async () => {
    const gmail = fakeGmail({
      'threads/t1': () => ({
        id: 't1',
        messages: [
          gmailMessage('a', 'jane@supplier.example'),
          gmailMessage('b', mailbox, { labels: ['SENT'] }),
        ],
      }),
      labels,
    });
    const adapter = connector(gmail.fetch);
    const first = await run(adapter, 'message-threads.read', {
      thread: { externalId: 't1', scopeKey: '' },
      limit: 1,
    });
    expect(first.items.map((i) => i.source.externalId)).toEqual(['a']);
    const second = await run(adapter, 'message-threads.read', {
      thread: { externalId: 't1', scopeKey: '' },
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.data.direction)).toEqual(['outbound']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('message-attachments.read', () => {
  const parts = [
    { partId: '0', mimeType: 'text/plain', body: { data: b64('Body') } },
    {
      partId: '1',
      mimeType: 'text/csv',
      filename: 'po.csv',
      body: { attachmentId: 'ATTACHMENT-ID', size: 11 },
    },
  ];

  it('reads content by stable part ID and hashes it', async () => {
    const gmail = fakeGmail({
      'messages/m1': () =>
        gmailMessage('m1', 'jane@supplier.example', { parts }),
      'messages/m1/attachments/ATTACHMENT-ID': () => ({
        size: 11,
        data: b64('sku,qty\nA,1'),
      }),
      labels,
    });
    await expect(
      run(connector(gmail.fetch), 'message-attachments.read', {
        message: { externalId: 'm1', scopeKey: '' },
        attachment: { externalId: '1', scopeKey: 'm1' },
        maxBytes: 1000,
      }),
    ).resolves.toEqual({
      filename: 'po.csv',
      mimeType: 'text/csv',
      size: 11,
      sha256: createHash('sha256').update('sku,qty\nA,1').digest('hex'),
      base64: Buffer.from('sku,qty\nA,1').toString('base64'),
    });
  });

  it('refuses attachments above the size limit before downloading', async () => {
    const gmail = fakeGmail({
      'messages/m1': () =>
        gmailMessage('m1', 'jane@supplier.example', { parts }),
    });
    await expect(
      run(connector(gmail.fetch), 'message-attachments.read', {
        message: { externalId: 'm1', scopeKey: '' },
        attachment: { externalId: '1', scopeKey: 'm1' },
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ failure: { code: 'invalid_input' } });
    expect(gmail.calls).toHaveLength(1);
  });
});

describe('messages.send', () => {
  const outbound = {
    outboundId: '0b5c2c8e-1d1f-4c56-9a59-1b0d2a7e1c11',
    thread: { externalId: 't1', scopeKey: '' },
    inReplyTo: 'abc@supplier.example',
    references: ['abc@supplier.example'],
    to: [{ address: 'jane@supplier.example', name: 'Jane' }],
    cc: [],
    subject: 'Re: PO-1001',
    text: 'Confirmed.',
  };

  it('sends in the thread with a Message-ID derived from the outbound ID', async () => {
    const gmail = fakeGmail({
      messages: (url) => {
        expect(url.searchParams.get('q')).toBe(
          `rfc822msgid:luma.${outbound.outboundId}@shop.example`,
        );
        expect(url.searchParams.get('includeSpamTrash')).toBe('true');

        return {};
      },
      'messages/send': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          raw: string;
          threadId: string;
        };
        expect(body.threadId).toBe('t1');
        const raw = Buffer.from(body.raw, 'base64url').toString();
        expect(raw).toContain(
          `Message-ID: <luma.${outbound.outboundId}@shop.example>`,
        );
        expect(raw).toContain('From: ops@shop.example');
        expect(raw).toContain('In-Reply-To: <abc@supplier.example>');

        return { id: 'sent-1', threadId: 't1' };
      },
    });
    await expect(
      run(connector(gmail.fetch), 'messages.send', outbound, 'v0:action'),
    ).resolves.toEqual({
      status: 'accepted',
      evidenceRefs: [sentEvidenceId(tenantId, connectionId, 'sent-1')],
      providerRequestId: null,
      records: [
        { resource: 'message', externalId: 'sent-1' },
        { resource: 'thread', externalId: 't1' },
      ],
    });
  });

  it('refuses a send during a long quota cooldown before searching or sending', async () => {
    const gmail = fakeGmail({});
    const pacer = createQuotaPacer({ sleep: async () => {} });
    pacer.cooldown(3_600_000);
    const adapter = createGmailConnector({
      tenantId,
      connectionId,
      emailAddress: mailbox,
      accessToken: async () => 'access-token',
      fetch: gmail.fetch,
      pacer,
      now: () => new Date('2026-10-03T00:00:00Z'),
    });
    await expect(
      run(adapter, 'messages.send', outbound, 'v0:action'),
    ).rejects.toMatchObject({
      failure: {
        code: 'rate_limited',
        effect: 'none',
        retry: 'after_delay',
        dispatch: 'not_dispatched',
      },
    });
    expect(gmail.calls).toHaveLength(0);
  });

  it('treats an existing ID as a conflict without accepting or sending it', async () => {
    const gmail = fakeGmail({
      messages: () => ({ messages: [{ id: 'earlier', threadId: 't1' }] }),
    });
    await expect(
      run(connector(gmail.fetch), 'messages.send', outbound, 'v0:action'),
    ).rejects.toMatchObject({ failure: { code: 'conflict' } });
    expect(gmail.calls.map((c) => c.url.pathname)).not.toContain(
      '/gmail/v1/users/me/messages/send',
    );
  });

  it('reports a server error after dispatch as uncertain', async () => {
    const gmail = fakeGmail({
      messages: () => ({}),
      'messages/send': () => new Response('{}', { status: 500 }),
    });
    const error = await run(
      connector(gmail.fetch),
      'messages.send',
      outbound,
      'v0:action',
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).failure).toMatchObject({
      effect: 'unknown',
      retry: 'reconcile',
    });
  });

  it('rejects header injection before contacting Gmail', () => {
    const handler = connector(fakeGmail({}).fetch).capabilities[
      'messages.send'
    ]!;
    expect(() =>
      handler.parseInput({ ...outbound, subject: 'Hi\r\nBcc: x@evil.example' }),
    ).toThrow();
  });
});

describe('new supplier email threads', () => {
  it('verifies a newly composed send through a read-only lookup of its sent Message-ID', async () => {
    const outboundId = '11111111-1111-4111-8111-111111111111';
    const gmail = fakeGmail({
      messages: (url) => {
        // A message someone else sent with the same Message-ID must not choose the thread.
        expect(url.searchParams.get('q')).toBe(
          `in:sent rfc822msgid:luma.${outboundId}@shop.example`,
        );

        return { messages: [{ id: 'sent', threadId: 't-new' }] };
      },
      'threads/t-new': () => ({
        id: 't-new',
        messages: [gmailMessage('sent', mailbox, { labels: ['SENT'] })],
      }),
      labels,
    });
    const result = await run(connector(gmail.fetch), 'message-threads.read', {
      thread: { externalId: `outbound:${outboundId}`, scopeKey: '' },
      limit: 50,
    });
    expect(result.items).toHaveLength(1);
    expect(gmail.calls.every((call) => call.init?.method !== 'POST')).toBe(
      true,
    );
  });
  it('keeps a not-yet-indexed send inconclusive and never dispatches it again', async () => {
    const gmail = fakeGmail({ messages: () => ({}) });
    const result = await run(connector(gmail.fetch), 'message-threads.read', {
      thread: { externalId: 'outbound:pending', scopeKey: '' },
      limit: 50,
    });
    expect(result.items).toEqual([]);
    expect(gmail.calls).toHaveLength(1);
  });
});
