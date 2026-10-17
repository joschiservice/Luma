/**
 * Browser security headers for every customer API response. The API serves only JSON and
 * event streams, so the policy forbids loading any subresource, framing, plugins and form
 * submissions. HSTS is sent only when the configured public origin uses HTTPS, so local
 * HTTP development never pins a host to HTTPS.
 */
export function apiSecurityHeaders(
  httpsOrigin: boolean,
): Record<string, string> {
  return {
    'content-security-policy':
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(httpsOrigin ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}
