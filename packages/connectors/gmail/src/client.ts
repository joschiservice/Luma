import { ConnectorError, type ConnectorErrorCode } from '@luma/connector-core';
import {
  fail,
  parse,
  type ReadRetry,
  retryAfterMs,
  retryRead,
} from '@luma/connector-core/transport';

import {
  createQuotaPacer,
  type GmailMethod,
  type QuotaPacer,
  quotaUnits,
} from './pacer.js';
import * as s from './schemas.js';

/** The Gmail API root for the authorized user's own mailbox. */
const API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me/';

export interface GmailTransportOptions {
  /** OAuth access token, resolved on every request so refreshes apply at once. */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Repetition of reads after short transient failures; defaults to three attempts. */
  readRetry?: ReadRetry;
  /** Admission shared by every client of the same mailbox. */
  pacer?: QuotaPacer;
}

const token = /^[\x21-\x7e]{1,4096}$/;

/** Gmail reports these 403 and 429 reasons for quota and rate limits. */
const rateReasons = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
]);

/** Daily quota exhaustion clears only when the quota window rolls over. */
const dailyReasons = new Set(['dailyLimitExceeded', 'quotaExceeded']);

function reasonsOf(body: unknown): string[] {
  const result = s.errorBody.safeParse(body);
  if (!result.success) return [];

  return [
    ...(result.data.error.errors ?? []),
    ...(result.data.error.details ?? []),
  ].flatMap((item) => (item.reason ? [item.reason] : []));
}

/**
 * Maps a Gmail error response to a normalized failure without the provider's message text.
 * `write` marks failures after a send was dispatched, whose effect is unknown unless Gmail
 * definitely rejected the request.
 */
export function gmailFailure(
  status: number,
  body: unknown,
  retryAfter: string | null,
  write = false,
): ConnectorError {
  const reasons = reasonsOf(body);
  const none = (code: ConnectorErrorCode, delayMs?: number) =>
    new ConnectorError({
      code,
      effect: 'none',
      retry: delayMs === undefined ? 'never' : 'after_delay',
      ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }),
      ...(write ? { dispatch: 'dispatched' as const } : {}),
    });
  if (status === 401) return none('authentication');
  if (
    status === 429 ||
    (status === 403 && reasons.some((r) => rateReasons.has(r)))
  ) {
    const daily = reasons.some((r) => dailyReasons.has(r));
    const delayMs =
      retryAfter !== null ? retryAfterMs(retryAfter) : daily ? 3_600_000 : 1000;

    return none('rate_limited', delayMs);
  }
  if (status === 403) return none('permission_denied');
  if (status === 404) return none('not_found');
  if (status === 400 || status === 413 || status === 422)
    return none('invalid_input');
  if (status === 409 || status === 412) return none('conflict');
  if (status >= 500) {
    if (write)
      return new ConnectorError({
        code: 'unavailable',
        effect: 'unknown',
        retry: 'reconcile',
        dispatch: 'uncertain',
      });

    return none('unavailable', 1000);
  }

  return write
    ? new ConnectorError({
        code: 'invalid_response',
        effect: 'unknown',
        retry: 'reconcile',
        dispatch: 'uncertain',
      })
    : none('invalid_response');
}

/**
 * Creates a paced, authenticated Gmail client for one mailbox. Requests reject redirects, time
 * out after 15 seconds by default, retry short transient read failures in place and map
 * provider failures to connector codes without their text. Sends are never repeated.
 */
export function createClient(options: GmailTransportOptions) {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('invalid_input');
  const pacer = options.pacer ?? createQuotaPacer();

  async function send(
    method: GmailMethod,
    path: string,
    request: {
      query?: Record<string, string | string[] | undefined> | undefined;
      body?: unknown;
      write?: boolean;
    } = {},
  ): Promise<unknown> {
    const url = new URL(path, API_ROOT);
    for (const [key, value] of Object.entries(request.query ?? {}))
      for (const item of value === undefined ? [] : [value].flat())
        url.searchParams.append(key, item);
    let accessToken: string;
    try {
      accessToken = await options.accessToken();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      fail('transient', 1000);
    }
    if (!token.test(accessToken)) fail('authentication');
    const write = request.write === true;
    let signal: AbortSignal | undefined;
    let dispatched = false;
    try {
      const response = await pacer.run(quotaUnits[method], () => {
        signal = AbortSignal.timeout(timeoutMs);
        dispatched = true;

        return (options.fetch ?? globalThis.fetch)(url, {
          method: request.body === undefined ? 'GET' : 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            ...(request.body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
          redirect: 'error',
          signal,
        });
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        if (response.ok) throw gmailFailure(502, null, null, write);
      }
      if (!response.ok) {
        const failure = gmailFailure(
          response.status,
          body,
          response.headers.get('retry-after'),
          write,
        );
        if (failure.failure.code === 'rate_limited')
          pacer.cooldown(failure.failure.retryAfterMs ?? 1000);
        throw failure;
      }

      return body;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const timedOut =
        signal?.aborted ||
        (error instanceof Error &&
          ['AbortError', 'TimeoutError'].includes(error.name));
      if (write && dispatched)
        throw new ConnectorError({
          code: timedOut ? 'timeout' : 'transient',
          effect: 'unknown',
          retry: 'reconcile',
          dispatch: 'uncertain',
        });
      fail(timedOut ? 'timeout' : 'transient', 1000);
    }
  }

  const read = (
    method: GmailMethod,
    path: string,
    query?: Record<string, string | string[] | undefined>,
  ) => retryRead(() => send(method, path, { query }), options.readRetry);

  return {
    /** The mailbox address and current history ID. */
    async profile() {
      return parse(s.profile, await read('users.getProfile', 'profile'));
    },
    /** System and user labels with their IDs and names. */
    async labels() {
      return parse(s.labels, await read('users.labels.list', 'labels'));
    },
    /** One page of message IDs matching a Gmail search query, newest first. */
    async listMessages(query: {
      q: string;
      pageToken?: string | undefined;
      maxResults: number;
      /** Also searches spam and trash, for example to find an earlier send. */
      includeSpamTrash?: boolean;
    }) {
      return parse(
        s.messageList,
        await read('users.messages.list', 'messages', {
          q: query.q,
          maxResults: String(query.maxResults),
          pageToken: query.pageToken,
          includeSpamTrash: query.includeSpamTrash ? 'true' : 'false',
        }),
      );
    },
    /** A complete message with its parsed MIME structure. */
    async getMessage(id: string) {
      const result = parse(
        s.message,
        await read(
          'users.messages.get',
          `messages/${encodeURIComponent(s.gmailId.parse(id))}`,
          { format: 'full' },
        ),
      );
      if (result.id !== id) fail('invalid_response');

      return result;
    },
    /** Every message of a thread with its parsed MIME structure. */
    async getThread(id: string) {
      const result = parse(
        s.thread,
        await read(
          'users.threads.get',
          `threads/${encodeURIComponent(s.gmailId.parse(id))}`,
          { format: 'full' },
        ),
      );
      if (result.id !== id) fail('invalid_response');

      return result;
    },
    /** The base64url content of one attachment. */
    async getAttachment(messageId: string, attachmentId: string) {
      if (!/^[A-Za-z0-9_-]{1,4096}$/.test(attachmentId)) fail('invalid_input');

      return parse(
        s.attachment,
        await read(
          'users.messages.attachments.get',
          `messages/${encodeURIComponent(s.gmailId.parse(messageId))}/attachments/${attachmentId}`,
        ),
      );
    },
    /**
     * Sends one RFC 5322 message, in the given thread when replying. Sent once: a failure after
     * dispatch has an unknown effect and must be reconciled by reading the mailbox.
     */
    async sendMessage(raw: string, threadId: string | null) {
      return parse(
        s.sent,
        await send('users.messages.send', 'messages/send', {
          body: { raw, ...(threadId ? { threadId } : {}) },
          write: true,
        }),
      );
    },
    /** Starts or renews push notifications for the given labels to a Pub/Sub topic. */
    async watch(topicName: string, labelIds: string[]) {
      return parse(
        s.watch,
        await send('users.watch', 'watch', {
          body: { topicName, labelIds, labelFilterBehavior: 'INCLUDE' },
        }),
      );
    },
    /** Stops push notifications for the mailbox. */
    async stop() {
      await send('users.stop', 'stop', { body: {} });
    },
  };
}

export type GmailClient = ReturnType<typeof createClient>;
