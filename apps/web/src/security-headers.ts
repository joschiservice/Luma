/**
 * Creates a Content Security Policy nonce: 128 random bits, base64-encoded. Each response
 * needs its own nonce; reusing one would let injected markup copy it from an earlier page.
 */
export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes));
}

/**
 * Builds the web app's Content Security Policy for one response. Scripts run only when they
 * carry the response's nonce or are loaded by a script that does (`'strict-dynamic'`), so
 * injected markup cannot run script. The browser reaches the API through the same-origin
 * `/api` proxy, so network, image and font loads stay on this origin; `data:` and `blob:`
 * images allow generated images. Styles allow inline content because React `style`
 * attributes and the code editor's injected stylesheets cannot carry a nonce.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Adds browser security headers to a web app response. The policy restricts scripts to the
 * request's nonce, which the server entry also hands to the router so every framework and
 * theme script carries it. The page may not be framed, load plugins or change its base URL.
 *
 * HSTS is sent only in production. Browsers ignore it on plain HTTP responses, and omitting
 * it in development keeps local hosts from being pinned to HTTPS. Headers a response already
 * sets, such as a stricter referrer policy on redirects, are kept.
 */
export function withSecurityHeaders(
  response: Response,
  options: { production: boolean; nonce: string },
): Response {
  // Responses from `fetch` have immutable headers, so headers are set on a copy.
  const secured = new Response(response.body, response);
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(options.nonce),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(options.production
      ? { 'Strict-Transport-Security': 'max-age=31536000' }
      : {}),
  };
  for (const [name, value] of Object.entries(headers))
    if (!secured.headers.has(name)) secured.headers.set(name, value);

  return secured;
}
