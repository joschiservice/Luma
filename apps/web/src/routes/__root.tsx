import { getLocale } from '@luma/i18n/runtime';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import { themeBootScript, watchTheme } from '../lib/theme';
import { zodConfigBootScript } from '../lib/zod-config';
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
  const nonce = useRouter().options.ssr?.nonce;
  useEffect(() => watchTheme(), []);

  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: themeBootScript }}
        />
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: zodConfigBootScript }}
        />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
