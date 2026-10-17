import { describe, expect, it } from 'vitest';

import { globalEntryRedirect } from './global-entry';
import { createCspNonce, withSecurityHeaders } from './security-headers';

describe('web security headers', () => {
  it('restricts scripts to the response nonce and forbids framing, plugins and base URL changes', async () => {
    const response = withSecurityHeaders(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
      { production: false, nonce: 'n0nce' },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html></html>');
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'text/html',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'nonce-n0nce' 'strict-dynamic'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('adds HSTS in production and keeps stricter headers on global entry redirects', () => {
    const redirect = globalEntryRedirect(
      new Request('https://app.example.test/'),
      {
        LUMA_REGION: 'AU',
        LUMA_GLOBAL_ENTRY_URL: 'https://app.example.test',
        LUMA_REGIONAL_ORIGINS: '{"AU":"https://au.app.example.test"}',
      },
    );
    if (!redirect) throw new Error('Expected a global entry redirect');
    const response = withSecurityHeaders(redirect, {
      production: true,
      nonce: createCspNonce(),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://au.app.example.test/',
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
  });

  it('secures responses whose headers are immutable', () => {
    const immutable = Response.redirect('https://example.test/', 302);
    expect(() => immutable.headers.set('x-test', '1')).toThrow();
    expect(
      withSecurityHeaders(immutable, {
        production: false,
        nonce: createCspNonce(),
      }).headers.get('x-content-type-options'),
    ).toBe('nosniff');
  });

  it('creates an unpredictable base64 nonce for each response', () => {
    const nonces = new Set(Array.from({ length: 100 }, createCspNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });
});
