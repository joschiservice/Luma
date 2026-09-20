import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import stylesheet from '../styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: 'Luma' },
      ],
      links: [{ rel: 'stylesheet', href: stylesheet }],
    }),
    component: Root,
  },
);

function Root() {
  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle('dark', preference.matches);
    apply();
    preference.addEventListener('change', apply);

    return () => preference.removeEventListener('change', apply);
  }, []);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.documentElement.classList.toggle('dark',window.matchMedia('(prefers-color-scheme: dark)').matches)",
          }}
        />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
