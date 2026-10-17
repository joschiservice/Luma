import { paraglideMiddleware } from '@luma/i18n/server';
import handler from '@tanstack/react-start/server-entry';

import { globalEntryRedirect } from './global-entry';
import { createCspNonce, withSecurityHeaders } from './security-headers';

/**
 * Serves the web app with the request's interface language, read from the language cookie or
 * the browser's preferred languages, available to every render and server handler. Every
 * response, including global entry redirects, carries the browser security headers. Each
 * request gets a fresh script nonce; the router reads it from the request context and adds
 * it to every inline and module script it renders.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const options = {
      production: process.env.NODE_ENV === 'production',
      nonce: createCspNonce(),
    };
    const redirect = globalEntryRedirect(request, process.env);
    if (redirect) return withSecurityHeaders(redirect, options);

    return withSecurityHeaders(
      await paraglideMiddleware(request, () =>
        handler.fetch(request, { context: { nonce: options.nonce } }),
      ),
      options,
    );
  },
};
