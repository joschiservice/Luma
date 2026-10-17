import { createApiClient } from '@luma/api-contract/client';

import { ApiError } from './api-error';

/**
 * Creates an API client using same-origin credentials and the browser's /api URL. Calls
 * resolve with the validated response body and reject with `ApiError`, or the error
 * `toError` creates, for error statuses. Pass an absolute API URL when calling from the server.
 */
export function createWebApiClient(
  baseUrl = '/api',
  toError: (status: number, body: unknown) => Error = (status, body) =>
    new ApiError(status, body),
) {
  return createApiClient({ baseUrl, credentials: 'same-origin', toError });
}
