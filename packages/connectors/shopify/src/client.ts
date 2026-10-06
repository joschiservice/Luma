import { ConnectorError } from '@luma/connector-core';
import {
  fail,
  parse,
  type ReadRetry,
  retryAfterMs,
  retryRead,
} from '@luma/connector-core/transport';
import { createAdminApiClient } from '@shopify/admin-api-client';
import { z } from 'zod';

import { createReadBudget, type ReadBudget } from './read-budget.js';

export { fail, parse } from '@luma/connector-core/transport';

export const API_VERSION = '2026-07';

export interface ShopifyTransportOptions {
  shop: string;
  /** Resolve a current access token from tenant-scoped secret storage on every request. */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Repetition of queries after transient failures; defaults to three attempts. */
  readRetry?: ReadRetry;
  /** Shared read budget for clients on the same tenant connection. */
  budget?: ReadBudget;
}

// Only documents that are plainly queries are repeated; mutations and anything unrecognized are not.
const queryDocument = /^\s*(?:query\b|\{)/;

/**
 * Creates a Shopify GraphQL client that resolves a current token for each request and
 * reports normalized connector failures. Queries are repeated briefly after transient
 * failures; mutations are sent once, because a failed response may follow an applied change.
 */
export function createClient(options: ShopifyTransportOptions): {
  (
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  nextReadDelay(): number;
} {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(options.shop))
    fail('invalid_input');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('invalid_input');
  const { readRetry } = options;
  const budget =
    options.budget ??
    createReadBudget(readRetry?.sleep ? { sleep: readRetry.sleep } : {});

  const send = async (
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    let token: string;
    try {
      token = await options.accessToken();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      fail('transient', 1000);
    }
    if (!token || /[\r\n]/.test(token)) fail('authentication');
    const signal = AbortSignal.timeout(timeoutMs);
    let transportTimedOut = false;
    let response: Response;
    let body: unknown;
    try {
      const client = createAdminApiClient({
        storeDomain: options.shop,
        apiVersion: API_VERSION,
        accessToken: token,
        retries: 0,
        logger: () => {
          // SDK logs can expose authenticated headers; evidence uses the capability hook.
        },
        customFetchApi: async (url, init) => {
          try {
            return await (options.fetch ?? globalThis.fetch)(url, {
              ...init,
              redirect: 'error',
              signal,
            });
          } catch (error) {
            // The SDK wraps transport errors, so preserve timeout classification before it does.
            transportTimedOut =
              signal.aborted ||
              (error instanceof Error &&
                ['AbortError', 'TimeoutError'].includes(error.name));
            throw error;
          }
        },
      });
      // Keep the raw response for Retry-After, API version checks and normalized GraphQL errors.
      response = await client.fetch(query, { variables });
      if (!response.ok) {
        if (response.status === 401) fail('authentication');
        if (response.status === 403) fail('permission_denied');
        if (response.status === 404) fail('not_found');
        if (response.status === 429) {
          const advised = retryAfterMs(response.headers.get('retry-after'));
          budget.cooldown(advised ?? 1000);
          fail('rate_limited', advised);
        }
        if (response.status >= 500) fail('transient', 1000);
        fail('invalid_response');
      }
      const version = response.headers.get('x-shopify-api-version');
      if (version && version !== API_VERSION) fail('unsupported_version');
      try {
        body = await response.json();
      } catch {
        if (signal.aborted) fail('timeout', 1000);
        fail('invalid_response');
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (signal.aborted || transportTimedOut) fail('timeout', 1000);
      fail('transient', 1000);
    }
    const envelope = parse(
      z.object({
        data: z.record(z.unknown()).nullable().optional(),
        errors: z
          .array(
            z.object({
              extensions: z
                .object({ code: z.string().optional() })
                .passthrough()
                .optional(),
            }),
          )
          .optional(),
        extensions: z
          .object({
            cost: z
              .object({
                requestedQueryCost: z.number().nonnegative(),
                throttleStatus: z.object({
                  currentlyAvailable: z.number().nonnegative(),
                  restoreRate: z.number().positive(),
                }),
              })
              .optional(),
          })
          .optional(),
      }),
      body,
    );
    const cost = envelope.extensions?.cost;
    if (cost)
      budget.observe(
        JSON.stringify([query, variables.first ?? null]),
        cost.requestedQueryCost,
        cost.throttleStatus.currentlyAvailable,
        cost.throttleStatus.restoreRate,
      );
    if (envelope.errors?.length) {
      const codes = envelope.errors.map((error) => error.extensions?.code);
      if (codes.includes('ACCESS_DENIED')) fail('permission_denied');
      if (codes.includes('THROTTLED')) {
        const cost = envelope.extensions?.cost;
        fail(
          'rate_limited',
          cost
            ? Math.max(
                1000,
                Math.ceil(
                  ((cost.requestedQueryCost -
                    cost.throttleStatus.currentlyAvailable) /
                    cost.throttleStatus.restoreRate) *
                    1000,
                ),
              )
            : 1000,
        );
      }
      if (codes.includes('INTERNAL_SERVER_ERROR')) fail('transient', 1000);
      fail('invalid_response');
    }
    if (!envelope.data) fail('invalid_response');

    return envelope.data;
  };

  return Object.assign(
    (query: string, variables: Record<string, unknown>) => {
      const attempt = () =>
        budget.run(JSON.stringify([query, variables.first ?? null]), () =>
          send(query, variables),
        );

      return queryDocument.test(query)
        ? retryRead(attempt, readRetry)
        : attempt();
    },
    { nextReadDelay: () => budget.nextDelay() },
  );
}
