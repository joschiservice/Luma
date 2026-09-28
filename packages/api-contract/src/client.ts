import type { ClientArgs, InitClientReturn } from '@ts-rest/core';
import { initClient } from '@ts-rest/core';

import { metricStreamEventSchema } from './contracts/events.js';
import { caseStreamEventSchema } from './desk.js';
import { apiContract } from './index.js';

export type ApiClient = InitClientReturn<typeof apiContract, ClientArgs>;

/**
 * Creates a typed API client that validates responses and rejects undocumented statuses.
 * Create a separate instance for each server request when using user credentials.
 */
export function createApiClient(options: ClientArgs): ApiClient {
  return initClient(apiContract, {
    ...options,
    validateResponse: true,
    throwOnUnknownStatus: true,
  });
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
