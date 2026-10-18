import { ConnectorError } from '@luma/connector-core';
import {
  assertDispatchAllowed,
  markDispatchPreparing,
  markDispatchStarted,
} from '@luma/connector-core/dispatch';
import {
  fail,
  parse,
  type ReadRetry,
  retryAfterMs,
  retryRead,
} from '@luma/connector-core/transport';
import { createAdminApiClient } from '@shopify/admin-api-client';
import { z } from 'zod';

import {
  type BudgetFeedback,
  createReadBudget,
  type ReadBudget,
  type RequestPurpose,
} from './read-budget.js';

export const API_VERSION = '2026-07';

export interface ShopifyTransportOptions {
  shop: string;
  /** Resolve a current access token from tenant-scoped secret storage on every request. */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Repetition of queries after transient failures; defaults to three attempts. */
  readRetry?: ReadRetry;
  /** Shared request budget for clients on the same trusted app/shop scope. */
  budget?: ReadBudget;
  /** Scheduling classification supplied by the owning service, never by request input. */
  purpose?: RequestPurpose;
  /** Stops admission waits and cancels an in-flight provider read when its caller goes away. */
  signal?: AbortSignal;
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
    feedback: BudgetFeedback,
  ): Promise<Record<string, unknown>> => {
    let token: string;
    try {
      token = await options.accessToken();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      fail('transient', 1000);
    }
    if (!token || /[\r\n]/.test(token)) fail('authentication');
    if (!queryDocument.test(query)) await assertDispatchAllowed();
    await feedback.beforeSend?.();
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
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
            signal.throwIfAborted();
            feedback.dispatched?.();
            if (!queryDocument.test(query)) markDispatchStarted();

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
          await feedback.cooldown(advised ?? 1000);
          if (!queryDocument.test(query))
            throw new ConnectorError({
              code: 'rate_limited',
              effect: 'none',
              retry: 'after_delay',
              retryAfterMs: advised ?? 1000,
              dispatch: 'not_dispatched',
            });
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
        data: z.record(z.string(), z.unknown()).nullable().optional(),
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
                actualQueryCost: z.number().nonnegative().nullable().optional(),
                throttleStatus: z.object({
                  currentlyAvailable: z.number().nonnegative(),
                  restoreRate: z.number().positive(),
                  maximumAvailable: z.number().positive().optional(),
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
      await feedback.observe(
        JSON.stringify([query, variables.first ?? null]),
        cost.requestedQueryCost,
        cost.throttleStatus.currentlyAvailable,
        cost.throttleStatus.restoreRate,
        cost.actualQueryCost ?? undefined,
        cost.throttleStatus.maximumAvailable,
      );
    if (envelope.errors?.length) {
      const codes = envelope.errors.map((error) => error.extensions?.code);
      if (codes.includes('ACCESS_DENIED')) fail('permission_denied');
      if (codes.includes('THROTTLED')) {
        const cost = envelope.extensions?.cost;
        const advised = cost
          ? Math.max(
              1000,
              Math.ceil(
                ((cost.requestedQueryCost -
                  cost.throttleStatus.currentlyAvailable) /
                  cost.throttleStatus.restoreRate) *
                  1000,
              ),
            )
          : 1000;
        await feedback.cooldown(advised);
        if (
          !queryDocument.test(query) &&
          !envelope.data &&
          codes.every((code) => code === 'THROTTLED')
        )
          throw new ConnectorError({
            code: 'rate_limited',
            effect: 'none',
            retry: 'after_delay',
            retryAfterMs: advised,
            dispatch: 'not_dispatched',
          });
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
      // Validation and cost errors mean Luma's query is wrong; the code tells them from drift.
      fail(
        'invalid_response',
        undefined,
        codes.find((code) => typeof code === 'string'),
      );
    }
    if (!envelope.data) fail('invalid_response');

    return envelope.data;
  };

  return Object.assign(
    (query: string, variables: Record<string, unknown>) => {
      const attempt = () => {
        if (!queryDocument.test(query)) markDispatchPreparing();

        return budget.run(
          JSON.stringify([query, variables.first ?? null]),
          (feedback) => send(query, variables, feedback),
          {
            ...(options.purpose ? { purpose: options.purpose } : {}),
            mutation: !queryDocument.test(query),
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
      };

      return queryDocument.test(query)
        ? retryRead(attempt, readRetry, options.signal)
        : attempt();
    },
    { nextReadDelay: () => budget.nextDelay() },
  );
}
