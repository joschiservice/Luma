import type { InstalledConnection } from '@luma/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import appStyles from '../../styles.css?inline';
import { AppSettings } from '../apps/settings';

export const organizationId = '22222222-2222-4222-8222-222222222222';

export const warehouse: InstalledConnection = {
  appId: 'jtl',
  provider: 'jtl',
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: organizationId,
  label: 'North warehouse',
  target: {
    kind: 'jtl-cloud',
    jtlTenantId: '33333333-3333-4333-8333-333333333333',
  },
  permissions: [
    'orders.read',
    'products.read',
    'inventory.read',
    'fulfillment.read',
    'orders.shipping-method.read',
    'orders.shipping-method.write',
  ],
  granted: [
    'orders.read',
    'products.read',
    'inventory.read',
    'fulfillment.read',
    'orders.shipping-method.read',
    'orders.shipping-method.write',
  ],
  status: 'active',
  version: 2,
  credentialVersion: 1,
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T01:00:00Z',
};

export const shopify: InstalledConnection = {
  ...warehouse,
  appId: 'shopify',
  provider: 'shopify',
  id: '44444444-4444-4444-8444-444444444444',
  label: 'Main store',
  target: { kind: 'shopify', shop: 'luma-demo.myshopify.com' },
  permissions: [
    'orders.read',
    'products.read',
    'inventory.read',
    'fulfillment.read',
  ],
  granted: [
    'orders.read',
    'products.read',
    'inventory.read',
    'fulfillment.read',
  ],
};

/** Provides isolated query state and application styles for connection previews. */
export function ConnectionsPreview({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );

  const [router] = useState(() => {
    const root = createRootRoute();
    const index = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => children,
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: '/app/$organizationId/apps/$appId/settings',
      component: () => {
        const { appId } = settings.useParams();

        return <AppSettings organizationId={organizationId} appId={appId} />;
      },
    });

    return createRouter({
      routeTree: root.addChildren([index, settings]),
      history: createMemoryHistory(),
      context: { queryClient: client },
    });
  });

  return (
    <QueryClientProvider client={client}>
      <style>{appStyles}</style>
      <div style={{ padding: 24, maxWidth: 1200, margin: 'auto' }}>
        <RouterProvider router={router} />
      </div>
    </QueryClientProvider>
  );
}

export type MockState = 'ready' | 'empty' | 'loading' | 'error' | 'member';

/** Keep every API request local to the preview, including credential and OAuth actions. */
export function mockConnections(state: MockState = 'ready') {
  const original = globalThis.fetch;
  let items = state === 'empty' ? [] : structuredClone([shopify, warehouse]);
  const catalog = [
    {
      id: 'shopify',
      name: 'Shopify',
      description: 'Read commerce data from your stores.',
      version: '1.0.0',
      category: 'storefront',
      ui: ['connections', 'settings'],
      connectionTypes: [{ kind: 'shopify', name: 'Shopify' }],
    },
    {
      id: 'jtl',
      name: 'JTL',
      description: 'Connect JTL Cloud or JTL-Wawi.',
      version: '1.0.0',
      category: 'erp',
      ui: ['connections', 'settings'],
      connectionTypes: [
        { kind: 'jtl-cloud', name: 'JTL Cloud' },
        { kind: 'jtl-onprem', name: 'JTL-Wawi on-premise' },
      ],
    },
  ];
  const installations =
    state === 'empty'
      ? []
      : catalog.map((app) => ({
          appId: app.id,
          status: 'installed',
          version: 1,
          updatedAt: '2026-09-18T00:00:00Z',
        }));
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    if (!url.pathname.startsWith('/api/')) return original(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const fail = (status: number) =>
      Response.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Preview response',
          requestId: 'storybook',
        },
        { status },
      );
    if (state === 'loading')
      return new Promise<Response>((_, reject) => {
        const signal =
          init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
      });
    if (url.pathname.endsWith('/context'))
      return Response.json({
        tenantId: organizationId,
        dataRegion: 'EU',
        requestId: 'storybook',
        actor: {
          type: 'user',
          id: organizationId,
          initiatingUserId: organizationId,
          sessionId: organizationId,
          membershipId: organizationId,
          role: state === 'member' ? 'member' : 'owner',
        },
      });
    if (state === 'error') return fail(503);
    if (url.pathname.endsWith('/apps'))
      return Response.json({ catalog, installations });
    const appAction = /\/apps\/([^/]+)\/(install|uninstall)$/.exec(
      url.pathname,
    );
    if (appAction) {
      const appId = appAction[1]!;
      const previous = installations.find((app) => app.appId === appId);
      const next = {
        appId,
        status: appAction[2] === 'install' ? 'installed' : 'uninstalled',
        version: (previous?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      if (previous) Object.assign(previous, next);
      else installations.push(next);

      return Response.json(next);
    }
    // OAuth is deliberately a local error, never a redirect to a real shop.
    if (url.pathname.endsWith('/shopify/authorize')) return fail(503);
    if (url.pathname.endsWith('/connections') && method === 'GET')
      return Response.json({ items });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname.endsWith('/connections') && method === 'POST') {
      const item: InstalledConnection = {
        ...warehouse,
        id: crypto.randomUUID(),
        target: body.target,
        label: body.label,
        permissions: body.permissions,
        granted: [],
        status: 'pending',
        version: 1,
      };
      items = [...items, item];

      return Response.json(item, { status: 201 });
    }
    const item = items.find((entry) => url.pathname.includes(entry.id));
    if (item && method === 'POST') {
      const updated: InstalledConnection = {
        ...item,
        version: item.version + 1,
        status: url.pathname.endsWith('/disconnect')
          ? 'disconnected'
          : url.pathname.endsWith('/credentials')
            ? 'pending'
            : 'active',
        granted: url.pathname.endsWith('/check')
          ? item.permissions
          : item.granted,
      };
      items = items.map((entry) => (entry.id === item.id ? updated : entry));

      return Response.json(updated);
    }

    return fail(503);
  };

  return () => {
    globalThis.fetch = original;
  };
}
