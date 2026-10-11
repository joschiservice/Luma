import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

import { clearPrivate } from './kit/identity/data';
import { createQueryClient } from './lib/query-client';
import { routeTree } from './routeTree.gen';

/** Creates a router with an isolated query client and the generated route tree. */
export function getRouter() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
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
