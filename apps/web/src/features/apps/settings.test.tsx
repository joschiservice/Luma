import type { AppManifest, InstalledConnection } from '@luma/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { connectionsOptions } from '../connections/data';
import { contextFixture } from '../identity/context.fixture';
import { contextOptions } from '../identity/data';
import { appsOptions } from './data';
import { AppSettings } from './settings';
import { AppStore } from './store';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('./extension', () => ({
  AppExtension: ({ slot }: { slot: string }) => <p>Extension slot: {slot}</p>,
}));

const organizationId = '22222222-2222-4222-8222-222222222222';
const app: AppManifest = {
  id: 'jtl',
  name: 'JTL',
  description: 'Connect your ERP.',
  version: '1',
  category: 'erp',
  ui: ['connections', 'settings'],
  connectionTypes: [{ kind: 'jtl-cloud', name: 'JTL Cloud' }],
  permissions: [],
  scopes: ['orders.read'],
  slotAccess: {
    connections: 'connections.manage',
    settings: 'connections.manage',
    'app-settings': 'apps.manage',
  },
};
const connection: InstalledConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: organizationId,
  appId: 'jtl',
  label: 'Main warehouse',
  target: { kind: 'jtl-cloud', jtlTenantId: organizationId },
  permissions: ['orders.read'],
  granted: ['orders.read'],
  status: 'active',
  version: 1,
  credentialVersion: 1,
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
};

function render({
  manifest = app,
  role = 'owner',
  installed = true,
  catalog = true,
  overview = false,
  items = [connection],
}: {
  manifest?: AppManifest;
  role?: 'owner' | 'admin' | 'member';
  installed?: boolean;
  catalog?: boolean;
  overview?: boolean;
  items?: InstalledConnection[];
} = {}) {
  const client = new QueryClient();
  client.setQueryData(appsOptions(organizationId).queryKey, {
    catalog: catalog ? [manifest] : [],
    installations: [
      {
        appId: manifest.id,
        status: installed ? 'installed' : 'uninstalled',
        version: 1,
        updatedAt: connection.updatedAt,
        grantedScopes: installed ? ['orders.read'] : [],
        pendingScopes: [],
        roles: [],
      },
    ],
  });
  client.setQueryData(connectionsOptions(organizationId).queryKey, items);
  client.setQueryData(
    contextOptions(organizationId).queryKey,
    contextFixture(organizationId, role),
  );
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      {overview ? (
        <AppStore
          organizationId={organizationId}
          canManage={role === 'owner'}
          refresh={async () => {}}
        />
      ) : (
        <AppSettings organizationId={organizationId} appId={manifest.id} />
      )}
    </QueryClientProvider>,
  );
  client.clear();

  return html;
}

it('shows only the selected app’s connections and an explicit setup action', () => {
  const html = render({
    items: [
      connection,
      { ...connection, id: 'other', appId: 'shopify', label: 'Other store' },
    ],
  });
  expect(html).toContain('Main warehouse');
  expect(html).not.toContain('Other store');
  expect(html).toContain('Add connection');
  expect(html).not.toContain('Extension slot: connections');
});

it('allows members to inspect connections without mutation controls', () => {
  const html = render({ role: 'member' });
  expect(html).toContain('Main warehouse');
  expect(html).not.toContain('Add connection</button>');
  expect(html).not.toContain('Uninstall</button>');
  expect(html).not.toContain('Validate access');
});

it('hosts app-wide settings without a connection section for utility apps', () => {
  const html = render({
    manifest: { ...app, connectionTypes: [], ui: ['app-settings'] },
    items: [],
  });
  expect(html).toContain('Extension slot: app-settings');
  expect(html).not.toContain('id="app-connections"');
  expect(html).not.toContain('Add connection');
});

it.each([{ installed: false }, { catalog: false }])(
  'retains historical connections without mounting unavailable app UI: %j',
  (state) => {
    const html = render(state);
    expect(html).toContain('Main warehouse');
    expect(html).not.toContain('Extension slot:');
    expect(html).not.toContain('Add connection</button>');
    expect(html).not.toContain('Validate access');
  },
);

it('summarizes multiple connections and attention on the overview', () => {
  const html = render({
    overview: true,
    items: [connection, { ...connection, id: 'second', status: 'degraded' }],
  });
  expect(html).toContain('2 connections');
  expect(html).toContain('connection needs');
  expect(html).toContain('Manage app');
  expect(html).not.toContain('Main warehouse');
});
