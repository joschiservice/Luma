import { ConnectorError } from '@luma/connector-core';
import {
  fail,
  type ReadRetry,
  retryAfterMs,
  retryRead,
} from '@luma/connector-core/transport';
import { z } from 'zod';

import { createRequestPacer, type RequestPacer } from './pacer.js';

export { fail, parse } from '@luma/connector-core/transport';

export const API_VERSION = 'v2';

/** The fixed Cin7 Core API root; accounts are selected by header, not by host. */
export const API_ROOT = 'https://inventory.dearsystems.com/ExternalApi/v2/';

export interface Cin7Connection {
  /** Cin7 Core account ID. It selects the company and is not secret. */
  accountId: string;
  /** API application key, resolved on every request so rotation applies at once. */
  applicationKey(): Promise<string>;
}

export interface Cin7TransportOptions {
  connection: Cin7Connection;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Repetition of reads after short transient failures; defaults to three attempts. */
  readRetry?: ReadRetry;
  /** Admission shared by every client of the same API application. */
  pacer?: RequestPacer;
}

const header = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x20-\x7e]+$/);

export const accountId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * Cin7 enforces its limit per minute and documents no Retry-After header, so a throttled
 * application waits for the window to pass unless the response advises otherwise.
 */
const throttleMs = 60_000;

/**
 * Creates a paced, authenticated Cin7 Core read client. Requests reject redirects, time out
 * after 15 seconds by default and map provider failures to connector codes without their text.
 */
export function createClient(options: Cin7TransportOptions) {
  const { connection } = options;
  if (!accountId.safeParse(connection.accountId).success) fail('invalid_input');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('invalid_input');
  const pacer = options.pacer ?? createRequestPacer();

  async function send(
    path: string,
    query: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(path, API_ROOT);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    let key: string;
    try {
      key = await connection.applicationKey();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      fail('transient', 1000);
    }
    if (!header.safeParse(key).success || !key.trim()) fail('authentication');
    // The timeout starts at admission, not while the request waits for the pacer.
    let signal: AbortSignal | undefined;
    try {
      const response = await pacer.run(() => {
        signal = AbortSignal.timeout(timeoutMs);

        return (options.fetch ?? globalThis.fetch)(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'api-auth-accountid': connection.accountId,
            'api-auth-applicationkey': key,
          },
          redirect: 'error',
          signal,
        });
      });
      // Cin7 answers rejected credentials with 403.
      if ([401, 403].includes(response.status)) fail('authentication');
      if (response.status === 402) fail('permission_denied');
      if (response.status === 404) fail('not_found');
      if (response.status === 400) fail('invalid_input');
      if (response.status === 429 || response.status === 503) {
        const advised = response.headers.get('retry-after');
        const wait = advised === null ? throttleMs : retryAfterMs(advised);
        pacer.cooldown(wait);
        fail(response.status === 429 ? 'rate_limited' : 'transient', wait);
      }
      if (response.status >= 500) fail('transient', 1000);
      if (!response.ok) fail('invalid_response');
      try {
        // Node's JSON source context keeps decimal tokens exact before IEEE-754 rounding.
        return JSON.parse(
          await response.text(),
          (_key, value: unknown, context?: { source: string }) => {
            if (
              typeof value === 'number' &&
              context &&
              /[.eE]/.test(context.source)
            )
              return context.source;

            return value;
          },
        ) as unknown;
      } catch {
        if (signal?.aborted) fail('timeout', 1000);
        fail('invalid_response');
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (
        signal?.aborted ||
        (error instanceof Error &&
          ['AbortError', 'TimeoutError'].includes(error.name))
      )
        fail('timeout', 1000);
      fail('transient', 1000);
    }
  }

  return {
    /** Identifies the account for cursor binding. */
    binding: [API_ROOT, connection.accountId.toLowerCase()],
    /** Milliseconds until the pacer admits the next request. */
    nextDelay: () => pacer.nextDelay(),
    /** Sends one read; short transient failures are repeated in place. */
    request(path: string, query: Record<string, string> = {}) {
      return retryRead(() => send(path, query), options.readRetry);
    },
  };
}

export type Cin7Client = ReturnType<typeof createClient>;
