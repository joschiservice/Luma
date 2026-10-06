import type { HttpFailureContext } from '../application/observability.js';

export const filtered = '[Filtered]';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const word = /^(?:v\d{1,3}|[a-z]+(?:[-_][a-z]+)*)$/;
// Bounded view parameters; search text, cursors, OAuth codes and state stay filtered.
const queryKeys = new Set([
  'window',
  'limit',
  'offset',
  'page',
  'pageSize',
  'sort',
  'order',
  'direction',
  'view',
  'environment',
  'format',
  'status',
]);
const ipHeaders = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
]);
const secretHeader =
  /cookie|authorization|token|secret|password|session|signature|hmac|api-?key|credential|csrf|xsrf|^x-amz-|shop-domain/i;

/**
 * Keeps a URL's route words and record UUIDs, replaces other path values with their route
 * parameter name or `[Filtered]`, and filters query values outside a small allowlist.
 */
export function redactUrl(url: string, route?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://redacted.invalid');
  } catch {
    return filtered;
  }
  const segments = parsed.pathname.split('/');
  const pattern = route?.split('/');
  const path = segments
    .map((segment, index) => {
      const part = pattern?.length === segments.length ? pattern[index] : '';
      if (part?.startsWith(':')) return uuid.test(segment) ? segment : part;
      if (part && part !== '*') return segment;

      return segment === '' || uuid.test(segment) || word.test(segment)
        ? segment
        : filtered;
    })
    .join('/');
  const query = [...parsed.searchParams]
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${queryKeys.has(key) && /^[\w.:-]{1,40}$/.test(value) ? encodeURIComponent(value) : filtered}`,
    )
    .join('&');
  const origin = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? parsed.origin : '';

  return `${origin}${path}${query ? `?${query}` : ''}`;
}

/** Filters credential, signature, session and client address headers; redacts referrer URLs. */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    if (raw === undefined) continue;
    const key = name.toLowerCase();
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    result[key] =
      ipHeaders.has(key) || secretHeader.test(key)
        ? filtered
        : key === 'referer'
          ? redactUrl(value)
          : value;
  }

  return result;
}

/** Redacts the request facts attached to an unexpected HTTP failure. */
export function redactHttpFailure(request: HttpFailureContext) {
  return {
    method: request.method,
    route: request.route,
    url: redactUrl(request.url, request.route),
    headers: redactHeaders(request.headers ?? {}),
  };
}
