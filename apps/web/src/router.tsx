import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import {
  createIsomorphicFn,
  getGlobalStartContext,
} from '@tanstack/react-start';

import { clearPrivate } from './kit/identity/data';
import { createQueryClient } from './lib/query-client';
import { routeTree } from './routeTree.gen';

/**
 * Reads the response's script nonce. The server takes it from the request context set by the
 * server entry and returns nothing when the router is created outside a request, such as for
 * a redirect that renders no HTML. The browser reads the nonce that the server rendered into
 * the `csp-nonce` meta tag, so hydrated head and body scripts match the server markup.
 */
const getCspNonce = createIsomorphicFn()
  .server(() => {
    try {
      return nonceFrom(getGlobalStartContext());
    } catch {
      return undefined;
    }
  })
  .client(
    () =>
      document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
        ?.content,
  );

// Start types the request context from registered middleware, and this app registers none.
function nonceFrom(context: { nonce?: unknown } | undefined) {
  return typeof context?.nonce === 'string' ? context.nonce : undefined;
}

/**
 * Creates a router with an isolated query client, the generated route tree and the request's
 * script nonce.
 */
export function getRouter() {
  const queryClient = createQueryClient();
  const nonce = getCspNonce();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    ssr: nonce ? { nonce } : {},
  });
  router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
    const previous = fromLocation?.pathname.match(
      /^\/app\/([0-9a-f-]{36})(?:\/|$)/i,
    )?.[1];
    const next = toLocation.pathname.match(
      /^\/app\/([0-9a-f-]{36})(?:\/|$)/i,
    )?.[1];
    if (previous && previous !== next) void clearPrivate(queryClient, previous);
    if (
      fromLocation?.pathname.startsWith('/app') &&
      !toLocation.pathname.startsWith('/app')
    ) {
      void clearPrivate(queryClient);
    }
  });
  // Installs the provider and handles server dehydration/client hydration.
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
