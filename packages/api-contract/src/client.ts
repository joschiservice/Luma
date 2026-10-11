import { createORPCClient, ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import { OpenAPILink } from '@orpc/openapi-client/fetch';

import { metricStreamEventSchema } from './contracts/events.js';
import { caseStreamEventSchema } from './desk.js';
import { apiContract } from './index.js';

/** Per-call client context. `headers` adds request headers, such as `x-luma-action-id`. */
export interface ApiClientContext {
  headers?: Record<string, string>;
}

export type ApiClient = ContractRouterClient<
  typeof apiContract,
  ApiClientContext
>;

/** A response with an error status. `body` is the API error payload when the server sent one. */
class ApiResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiResponseError';
  }
}

export interface ApiClientOptions {
  /** API base URL. A relative URL, such as `/api`, resolves against the current page. */
  baseUrl: string;
  credentials?: RequestInit['credentials'];
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  /** Creates the error thrown for an error status; defaults to `ApiResponseError`. */
  toError?: (status: number, body: unknown) => Error;
}

/**
 * Creates a typed API client. Calls resolve with the validated response body and reject with
 * `toError` for error statuses; responses that do not match the contract reject with a
 * validation error. Pass `{ signal }` as the second argument to cancel a call. Create a separate
 * instance for each server request when using user credentials.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const toError =
    options.toError ??
    ((status: number, body: unknown) => new ApiResponseError(status, body));
  const link = new OpenAPILink<ApiClientContext>(apiContract, {
    url: () =>
      new URL(
        options.baseUrl,
        (globalThis as { location?: { href: string } }).location?.href,
      ),
    headers: ({ context }) => ({ ...options.headers, ...context.headers }),
    fetch: (request, init) =>
      (options.fetch ?? globalThis.fetch)(request, {
        ...init,
        credentials: options.credentials ?? 'same-origin',
        cache: 'no-store',
      }),
    interceptors: [
      async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          if (error instanceof ORPCError && typeof error.status === 'number')
            throw toError(error.status, errorBody(error.data));
          throw error;
        }
      },
    ],
    plugins: [new ResponseValidationPlugin(apiContract)],
  });

  return createORPCClient(link);
}

/** The link wraps non-oRPC error responses as `{ status, headers, body }`. */
function errorBody(data: unknown) {
  return data && typeof data === 'object' && 'body' in data
    ? data.body
    : undefined;
}

/** Reconnects automatically. Refetch case, review, progress and timeline on each resync. */
export function subscribeToCaseProgress(options: {
  baseUrl: string;
  organizationId: string;
  exceptionId: string;
  onResync: (event: import('./desk.js').CaseProgress) => void;
  onError: () => void;
}) {
  const source = new EventSource(
    `${options.baseUrl.replace(/\/$/, '')}/v1/organizations/${encodeURIComponent(options.organizationId)}/exceptions/${encodeURIComponent(options.exceptionId)}/events`,
    { withCredentials: true },
  );
  source.addEventListener('resync', (event) => {
    try {
      if (!('data' in event) || typeof event.data !== 'string')
        throw new Error('Invalid case stream event');
      const snapshot = caseStreamEventSchema.parse(JSON.parse(event.data));
      if (snapshot.exceptionId !== options.exceptionId)
        throw new Error('Case stream mismatch');
      options.onResync(snapshot.progress);
    } catch {
      source.close();
      options.onError();
    }
  });
  source.addEventListener('error', options.onError);

  return () => source.close();
}

/** Opens scoped invalidations; reconnects request current state rather than replaying deltas. */
export function subscribeToMetrics(options: {
  baseUrl: string;
  organizationId: string;
  onResync: (
    event: import('zod').infer<typeof metricStreamEventSchema>,
  ) => void;
  onError: () => void;
}) {
  const source = new EventSource(
    `${options.baseUrl.replace(/\/$/, '')}/v1/organizations/${encodeURIComponent(options.organizationId)}/metrics/events`,
    { withCredentials: true },
  );
  source.addEventListener('resync', (event) => {
    try {
      const parsed = metricStreamEventSchema.parse(
        JSON.parse((event as MessageEvent).data),
      );
      if (parsed.organizationId !== options.organizationId)
        throw new Error('Scope mismatch');
      options.onResync(parsed);
    } catch {
      source.close();
      options.onError();
    }
  });
  source.addEventListener('access-check', options.onError);
  source.addEventListener('error', options.onError);

  return () => source.close();
}
