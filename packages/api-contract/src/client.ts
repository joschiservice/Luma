import { initClient } from '@ts-rest/core';
import type { ClientArgs, InitClientReturn } from '@ts-rest/core';
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
