import { createApiClient } from '@luma/api-contract/client';

/**
 * Creates an API client using same-origin credentials and the browser's /api URL.
 * Pass an absolute API URL when calling from the server.
 */
export function createWebApiClient(baseUrl = '/api') {
  return createApiClient({ baseUrl, credentials: 'same-origin' });
}
