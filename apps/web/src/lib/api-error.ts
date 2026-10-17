import {
  type ApiError as ApiErrorPayload,
  apiErrorSchema,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

/**
 * A failed API or auth request. Keeps the HTTP status and, when the response carried the API
 * error payload, its `code`, `message` and `requestId`. `message` falls back to a generic
 * localized sentence when the server sent none, so check `code` before showing it to people,
 * or use `requestErrorMessage` from `kit/identity/errors`.
 */
export class ApiError extends Error {
  readonly code: ApiErrorPayload['code'] | undefined;
  readonly requestId: string | undefined;

  constructor(
    public status: number,
    body?: unknown,
  ) {
    const payload = body && typeof body === 'object' ? body : {};
    const message =
      'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : undefined;
    super(message ?? m.identity_error_unavailable());
    this.name = 'ApiError';
    const code = apiErrorSchema.shape.code.safeParse(
      'code' in payload ? payload.code : undefined,
    );
    this.code = code.success ? code.data : undefined;
    this.requestId =
      'requestId' in payload && typeof payload.requestId === 'string'
        ? payload.requestId
        : undefined;
  }
}
