import { ConnectorError } from '@luma/connector-core';
import {
  fail,
  type ReadRetry,
  retryAfterMs,
  retryRead,
} from '@luma/connector-core/transport';
import { z } from 'zod';

declare global {
  interface JSON {
    /** Node 24 preserves an already validated numeric token without IEEE-754 rounding. */
    rawJSON(value: string): unknown;
  }
}

export const API_VERSION = 'v1';
const root = 'https://api.starshipit.com/api/';
const key = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

export interface StarshipitTransportOptions {
  /** Credentials are refreshed before each request, including pagination. */
  credentials(): Promise<{ token: string; subscriptionKey: string }>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  readRetry?: ReadRetry;
}

/** Authenticated fixed-host reads and one-shot updates; dispatched write failures are uncertain. */
export function createClient(options: StarshipitTransportOptions) {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('invalid_input');

  async function send(
    path: 'orders' | 'track',
    query: URLSearchParams,
    body?: unknown,
  ): Promise<unknown> {
    const credentials = await options.credentials();
    if (
      !key.safeParse(credentials.token).success ||
      !key.safeParse(credentials.subscriptionKey).success
    )
      fail('authentication');
    const url = new URL(path, root);
    url.search = query.toString();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: body === undefined ? 'GET' : 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'StarShipIT-Api-Key': credentials.token,
          'Ocp-Apim-Subscription-Key': credentials.subscriptionKey,
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body, (field, value: unknown) =>
                ['weight', 'value'].includes(field) &&
                typeof value === 'string' &&
                /^\d{1,14}(?:\.\d{1,6})?$/.test(value)
                  ? JSON.rawJSON(value)
                  : value,
              ),
            }),
        redirect: 'error',
        signal,
      });
      if ([401, 403].includes(response.status))
        fail(response.status === 401 ? 'authentication' : 'permission_denied');
      if (response.status === 404) fail('not_found');
      if (response.status === 400) fail('invalid_input');
      if (response.status === 429)
        fail('rate_limited', retryAfterMs(response.headers.get('retry-after')));
      if (response.status >= 500) fail('transient', 1000);
      if (!response.ok) fail('invalid_response');
      const raw: unknown = JSON.parse(
        await response.text(),
        (_key, value: unknown, context?: { source: string }) =>
          typeof value === 'number' && context && /[.eE]/.test(context.source)
            ? context.source
            : value,
      );
      const envelope = z
        .object({
          success: z.boolean().optional(),
          succeeded: z.boolean().optional(),
        })
        .safeParse(raw);
      if (
        !envelope.success ||
        (envelope.data.success !== true && envelope.data.succeeded !== true)
      )
        fail('invalid_response');

      return raw;
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        (body === undefined ||
          [
            'authentication',
            'permission_denied',
            'not_found',
            'invalid_input',
            'rate_limited',
          ].includes(error.failure.code))
      )
        throw error;
      throw new ConnectorError({
        code:
          error instanceof ConnectorError
            ? error.failure.code
            : signal.aborted
              ? 'timeout'
              : 'transient',
        effect: body === undefined ? 'none' : 'unknown',
        retry: body === undefined ? 'after_delay' : 'never',
        ...(body === undefined ? { retryAfterMs: 1000 } : {}),
      });
    }
  }

  return {
    /** Retries only safe reads, with bounded delay advice. */
    read(path: 'orders' | 'track', query: URLSearchParams) {
      return retryRead(() => send(path, query), options.readRetry);
    },
    /** Sends a documented order update once, without claiming provider key deduplication. */
    update(order: unknown) {
      return send('orders', new URLSearchParams(), { order });
    },
  };
}
