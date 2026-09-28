import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { themeBootScript, watchTheme } from '../lib/theme';
import stylesheet from '../styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'color-scheme', content: 'light dark' },
        { title: 'Luma' },
      ],
      links: [
        { rel: 'stylesheet', href: stylesheet },
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      ],
    }),
    component: Root,
  },
);

function Root() {
  useEffect(() => watchTheme(), []);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
