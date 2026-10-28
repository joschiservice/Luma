import '@tanstack/react-start';

import { createFileRoute } from '@tanstack/react-router';

// Container health check: answers from the SSR server entry and its request middleware, unlike
// static files, without calling the API or a database.
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { status: 'ok' },
          { headers: { 'cache-control': 'no-store' } },
        ),
    },
  },
});
