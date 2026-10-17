import { m } from '@luma/i18n/messages';

import { IdentityError } from './data';

const unavailableCodes = new Set([
  'SERVICE_UNAVAILABLE',
  'REGION_UNAVAILABLE',
  'NOT_READY',
  'INTERNAL_ERROR',
]);

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function statusOf(error: unknown) {
  if (error instanceof IdentityError) return error.status;
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    typeof error.status === 'number'
  )
    return error.status;

  return undefined;
}

/**
 * Returns a localized sentence for a failed request when the screen has no more specific copy.
 * Network failures, sign-in, access, missing records, rate limits and server outages get
 * generic localized text with a next step. Other failures, such as validation errors and
 * conflicts, show the server's message when the response carried the API error payload, and
 * otherwise `fallback` or a generic sentence. Server messages are shown as delivered and are
 * not translated.
 */
export function requestErrorMessage(error: unknown, fallback?: string) {
  const status = statusOf(error);
  const code = error instanceof IdentityError ? error.code : undefined;

  if (isOffline() || status === 0 || error instanceof TypeError)
    return m.identity_error_network();
  if (status === 401 || code === 'UNAUTHENTICATED')
    return m.identity_error_unauthenticated();
  if (code === 'ACCESS_SUSPENDED') return m.identity_error_access_suspended();
  if (code === 'READ_ONLY') return m.identity_error_read_only();
  if (code === 'EMAIL_NOT_VERIFIED')
    return m.identity_auth_email_not_verified();
  if (status === 403 || code === 'FORBIDDEN')
    return m.identity_error_forbidden();
  if (status === 404 || code === 'NOT_FOUND')
    return m.identity_error_not_found();
  if (status === 429 || code === 'TOO_MANY_REQUESTS')
    return m.identity_error_rate_limited();
  if (
    (status !== undefined && status >= 500) ||
    unavailableCodes.has(code ?? '')
  )
    return m.identity_error_unavailable();
  if (error instanceof IdentityError && code && error.message)
    return error.message;

  return fallback ?? m.identity_error_unavailable();
}
