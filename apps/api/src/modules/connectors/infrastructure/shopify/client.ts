import { createAdminApiClient } from '@shopify/admin-api-client';
import { z } from 'zod';
import { ConnectorError } from '../../domain/capabilities.js';
import type { ConnectorErrorCode } from '../../domain/capabilities.js';

export const API_VERSION = '2026-07';
export function fail(code: ConnectorErrorCode, retryAfterMs?: number): never {
  throw new ConnectorError({
    code,
    effect: 'none',
    retry: retryAfterMs === undefined ? 'never' : 'after_delay',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
export function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('invalid_response');
  return result.data;
}
export interface ShopifyTransportOptions {
  shop: string;
  /** Resolve a current access token from tenant-scoped secret storage on every request. */
  accessToken(): Promise<string>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export function createClient(options: ShopifyTransportOptions) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(options.shop))
    fail('invalid_input');
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    fail('invalid_input');
  return async (
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const token = await options.accessToken();
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
        // SDK logs can include authenticated request headers; evidence uses the capability hook.
        logger: () => {},
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
          const header = response.headers.get('retry-after');
          const seconds = header === null ? NaN : Number(header);
          const delay = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(header ?? '') - Date.now();
          fail(
            'rate_limited',
            Number.isFinite(delay) && delay >= 0 ? Math.ceil(delay) : 1000,
          );
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
}
