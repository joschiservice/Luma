import { createHash } from 'node:crypto';

import {
  type AttachmentContent,
  type CapabilityDescriptor,
  type CapabilityHandler,
  type CapabilityInput,
  type CapabilityOutput,
  type ConnectorConnection,
  ConnectorError,
  type MessageSnapshot,
  type Observation,
  type WriteReceipt,
} from '@luma/connections';
import {
  buildQuery,
  composeMessage,
  createClient,
  createCursorCodec,
  decodeBase64,
  describeAttachment,
  encodeRaw,
  fail,
  findPart,
  type GmailClient,
  type GmailMessage,
  matchesFilter,
  type ParsedMessage,
  parseMessage,
  type QuotaPacer,
} from '@luma/connector-gmail';
import { z } from 'zod';

import { inputs, outputs } from './schemas.js';

/**
 * Version of this adapter's normalized output, recorded as observation provenance. Bump it
 * whenever the same provider response would normalize differently.
 */
const adapterVersion = 'gmail/1';

/** Messages fetched in full at once for one page. */
const detailConcurrency = 4;

/** Gmail's largest page of message IDs. */
const maxPage = 100;

/** Push registrations are renewed when they expire within this window; Gmail's last 7 days. */
const watchRenewalMs = 24 * 60 * 60 * 1000;

/** Stored Gmail push registration of one connection. */
export interface WatchState {
  topic: string;
  historyId: string;
  expiresAt: string;
}

export interface GmailConnectorOptions {
  tenantId: string;
  connectionId: string;
  /** Lower-case address of the connected mailbox. */
  emailAddress: string;
  /** OAuth access token, resolved for every request. */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch | undefined;
  /** Admission shared by every adapter of this mailbox. */
  pacer?: QuotaPacer | undefined;
  /** Renews Gmail push during message reads when push is configured. */
  watch?:
    | {
        topic: string;
        load(): Promise<WatchState | null>;
        save(state: WatchState): Promise<void>;
      }
    | undefined;
  now?: () => Date;
}

const cursorSchema = z
  .object({
    binding: z.string().regex(/^[0-9a-f]{64}$/),
    /** Gmail page token for message reads; the next message offset for thread reads. */
    page: z.union([z.string().min(1).max(4096), z.number().int().min(1)]),
  })
  .strict();
const cursorCodec = createCursorCodec(cursorSchema);

const readDescriptor: CapabilityDescriptor = {
  version: '0',
  minimumRisk: 'low',
  idempotency: 'none',
  retry: { maxAttempts: 3, initialDelayMs: 1000 },
};

/**
 * Sends happen once per outbound ID: before sending, the adapter searches the mailbox for the
 * Message-ID derived from it and returns the existing message instead.
 */
const sendDescriptor: CapabilityDescriptor = {
  version: '0',
  minimumRisk: 'low',
  idempotency: 'conditional_write',
  retry: { maxAttempts: 1, initialDelayMs: 0 },
  permission: 'gmail:messages.send',
};

/** The RFC Message-ID Luma gives an outbound message, without angle brackets. */
export function outboundMessageId(outboundId: string, mailbox: string) {
  return `luma.${outboundId}@${mailbox.slice(mailbox.lastIndexOf('@') + 1)}`;
}

/**
 * The evidence ID of a sent Gmail message: a UUID derived from the tenant, connection and
 * Gmail message ID, because execution keeps only tenant-owned UUIDs as evidence.
 */
export function sentEvidenceId(
  tenantId: string,
  connectionId: string,
  messageId: string,
) {
  const hex = createHash('sha256')
    .update(
      JSON.stringify(['gmail', 'sent', tenantId, connectionId, messageId]),
    )
    .digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Creates the Gmail adapter for one connection. Reads return messages as observations for the
 * messaging owner only; they are never recorded as commerce evidence because messages are
 * personal data with their own retention.
 */
export function createGmailConnector(
  options: GmailConnectorOptions,
): ConnectorConnection {
  if (!options.tenantId || !options.connectionId) fail('invalid_input');
  const client = createClient({
    accessToken: options.accessToken,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.pacer ? { pacer: options.pacer } : {}),
  });
  const now = options.now ?? (() => new Date());
  const mailbox = options.emailAddress.toLowerCase();

  const binding = (...parts: unknown[]) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          options.tenantId,
          options.connectionId,
          adapterVersion,
          ...parts,
        ]),
      )
      .digest('hex');

  function readCursor(value: string | undefined, expected: string) {
    if (!value) return null;
    const cursor = cursorCodec.decode(value);
    if (cursor.binding !== expected) fail('invalid_input');

    return cursor.page;
  }

  const writeCursor = (expected: string, page: string | number) =>
    cursorCodec.encode({ binding: expected, page });

  async function labelNames(gmail: GmailClient) {
    const result = await gmail.labels();

    return new Map((result.labels ?? []).map((l) => [l.id, l.name]));
  }

  function observe(
    parsed: ParsedMessage,
    historyId: string | undefined,
    observedAt: string,
  ): Observation<MessageSnapshot> {
    return {
      id: `gmail:${options.connectionId}:message:${parsed.id}`,
      source: {
        tenantId: options.tenantId,
        connectionId: options.connectionId,
        provider: 'gmail',
        resource: 'message',
        externalId: parsed.id,
        scopeKey: '',
      },
      kind: 'snapshot',
      observedAt,
      sourceUpdatedAt: null,
      sourceRevision: historyId ?? null,
      adapterVersion,
      schemaVersion: 1,
      data: {
        ...(parsed.deliveryFailure
          ? { deliveryFailure: parsed.deliveryFailure }
          : {}),
        thread: { externalId: parsed.threadId, scopeKey: '' },
        rfcMessageId: parsed.rfcMessageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        direction: parsed.direction,
        providerSent: parsed.providerSent === true,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        replyTo: parsed.replyTo,
        subject: parsed.subject,
        text: parsed.text,
        truncated: parsed.truncated,
        sentAt: parsed.sentAt,
        receivedAt: parsed.receivedAt,
        labels: parsed.labels,
        attachments: parsed.attachments.map((item) => ({
          attachment: { externalId: item.partId, scopeKey: parsed.id },
          filename: item.filename,
          mimeType: item.mimeType,
          size: item.size,
        })),
      },
    };
  }

  // A message deleted after it was listed has nothing left to report.
  async function maybe<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ConnectorError && error.failure.code === 'not_found')
        return null;
      throw error;
    }
  }

  // Push only shortens the delay before the next read, so its failures never fail a read.
  async function renewWatch() {
    const watch = options.watch;
    if (!watch) return;
    try {
      const current = await watch.load();
      if (
        current &&
        current.topic === watch.topic &&
        Date.parse(current.expiresAt) > now().getTime() + watchRenewalMs
      )
        return;
      const result = await client.watch(watch.topic, ['INBOX', 'SENT']);
      await watch.save({
        topic: watch.topic,
        historyId: result.historyId,
        expiresAt: new Date(Number(result.expiration)).toISOString(),
      });
    } catch {
      // The next read tries again; scheduled reads cover the mailbox meanwhile.
    }
  }

  function guard(
    context: Parameters<CapabilityHandler<'messages.read'>['run']>[0],
  ) {
    if (
      context.tenant.tenantId !== options.tenantId ||
      context.connectionId !== options.connectionId ||
      context.provider !== 'gmail'
    )
      fail('unavailable');
  }

  function handler<K extends keyof typeof inputs>(
    capability: K,
    descriptor: CapabilityDescriptor,
    run: (
      input: CapabilityInput<K>,
      context: Parameters<CapabilityHandler<K>['run']>[0],
    ) => Promise<CapabilityOutput<K>>,
  ): CapabilityHandler<K> {
    return {
      descriptor,
      parseInput: (value) =>
        inputs[capability].parse(value) as CapabilityInput<K>,
      parseOutput: (value) =>
        outputs[capability].parse(value) as CapabilityOutput<K>,
      async run(context, input) {
        guard(context);

        return run(input, context);
      },
    };
  }

  return {
    tenantId: options.tenantId,
    id: options.connectionId,
    provider: 'gmail',
    status: 'active',
    adapterVersion,
    mechanism: 'api',
    executor: { kind: 'connector', id: adapterVersion },
    capabilities: {
      'messages.read': handler(
        'messages.read',
        readDescriptor,
        async (input) => {
          const observedAt = now().toISOString();
          const q = buildQuery(input.filter, input.receivedSince);
          // An empty filter matches nothing, so nothing is requested from Gmail.
          if (!q)
            return { items: [], nextCursor: null, completeness: 'complete' };
          const expected = binding('messages.read', q, input.filter);
          const page = readCursor(input.cursor, expected);
          if (page === null) await renewWatch();
          const list = await client.listMessages({
            q,
            pageToken: typeof page === 'string' ? page : undefined,
            maxResults: Math.min(input.limit, maxPage),
          });
          const names = await labelNames(client);
          const messages = await mapConcurrent(
            list.messages ?? [],
            detailConcurrency,
            (item) => maybe(() => client.getMessage(item.id)),
          );
          const since =
            Math.floor(Date.parse(input.receivedSince) / 1000) * 1000;
          const items: Observation<MessageSnapshot>[] = [];
          for (const message of messages) {
            if (!message) continue;
            const parsed = parseMessage(message, mailbox, names);
            // Gmail search is broader than the filter; only exact matches leave the adapter.
            if (
              Date.parse(parsed.receivedAt) < since ||
              !matchesFilter(input.filter, {
                from: parsed.from.address,
                to: parsed.to.map((a) => a.address),
                cc: parsed.cc.map((a) => a.address),
                deliveredTo: parsed.deliveredTo,
                labels: parsed.labels,
                outbound: parsed.direction === 'outbound',
              })
            )
              continue;
            items.push(observe(parsed, message.historyId, observedAt));
          }

          return {
            items,
            nextCursor: list.nextPageToken
              ? writeCursor(expected, list.nextPageToken)
              : null,
            completeness: 'complete',
          };
        },
      ),
      'message-threads.read': handler(
        'message-threads.read',
        readDescriptor,
        async (input) => {
          const observedAt = now().toISOString();
          const expected = binding(
            'message-threads.read',
            input.thread.externalId,
            input.limit,
          );
          const offset = readCursor(input.cursor, expected) ?? 0;
          if (typeof offset !== 'number') fail('invalid_input');
          let providerThreadId = input.thread.externalId;
          if (providerThreadId.startsWith('outbound:')) {
            const messageId = outboundMessageId(
              providerThreadId.slice(9),
              mailbox,
            );
            const found = (
              await client.listMessages({
                q: `rfc822msgid:${messageId}`,
                maxResults: 1,
                includeSpamTrash: true,
              })
            ).messages?.[0];
            if (!found)
              return { items: [], nextCursor: null, completeness: 'complete' };
            providerThreadId = found.threadId;
          }
          const thread = await client.getThread(providerThreadId);
          const names = await labelNames(client);
          const all = thread.messages ?? [];
          const slice = all.slice(offset, offset + input.limit);

          return {
            items: slice.map((message: GmailMessage) =>
              observe(
                parseMessage(message, mailbox, names),
                message.historyId,
                observedAt,
              ),
            ),
            nextCursor:
              offset + input.limit < all.length
                ? writeCursor(expected, offset + input.limit)
                : null,
            completeness: 'complete',
          };
        },
      ),
      'message-attachments.read': handler(
        'message-attachments.read',
        readDescriptor,
        async (input) => {
          const message = await client.getMessage(input.message.externalId);
          if (
            input.attachment.scopeKey &&
            input.attachment.scopeKey !== input.message.externalId
          )
            fail('invalid_input');
          const part = findPart(message.payload, input.attachment.externalId);
          if (!part?.filename?.trim() || !part.body) fail('not_found');
          if ((part.body.size ?? 0) > input.maxBytes) fail('invalid_input');
          const data =
            part.body.data ??
            (part.body.attachmentId
              ? (
                  await client.getAttachment(
                    input.message.externalId,
                    part.body.attachmentId,
                  )
                ).data
              : fail('not_found'));
          const bytes = decodeBase64(data);
          if (bytes.length > input.maxBytes) fail('invalid_input');
          const described = describeAttachment(part);

          return {
            filename: described?.filename ?? part.filename.trim(),
            mimeType: described?.mimeType ?? 'application/octet-stream',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            base64: bytes.toString('base64'),
          } satisfies AttachmentContent;
        },
      ),
      'messages.send': handler(
        'messages.send',
        sendDescriptor,
        async (input, context) => {
          if (!context.idempotencyKey?.trim()) fail('invalid_input');
          const messageId = outboundMessageId(input.outboundId, mailbox);
          // An existing ID prevents redispatch, but search hits alone prove no send outcome.
          const existing = await client.listMessages({
            q: `rfc822msgid:${messageId}`,
            maxResults: 1,
            includeSpamTrash: true,
          });
          if (existing.messages?.length) fail('conflict');
          let raw: string;
          try {
            raw = composeMessage({
              from: { address: mailbox, name: null },
              to: input.to,
              cc: input.cc,
              subject: input.subject,
              text: input.text,
              messageId,
              inReplyTo: input.inReplyTo,
              references: input.references,
              date: now(),
              attachments: input.attachments ?? [],
            });
          } catch {
            fail('invalid_input');
          }
          const sent = await client.sendMessage(
            encodeRaw(raw),
            input.thread?.externalId ?? null,
          );

          return {
            status: 'accepted',
            evidenceRefs: [
              sentEvidenceId(options.tenantId, options.connectionId, sent.id),
            ],
            providerRequestId: null,
            records: [
              { resource: 'message', externalId: sent.id },
              { resource: 'thread', externalId: sent.threadId },
            ],
          } satisfies WriteReceipt;
        },
      ),
    },
  };
}

/** Maps items with at most `limit` calls in flight, in input order; stops after a failure. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await map(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );

  return results;
}
