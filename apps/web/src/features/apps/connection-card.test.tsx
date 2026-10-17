import type { InstalledConnection } from '@luma/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { ConnectionCard } from './connection-card';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const fixture: InstalledConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  label: 'Warehouse',
  target: {
    kind: 'jtl-cloud',
    jtlTenantId: '33333333-3333-4333-8333-333333333333',
  },
  permissions: [
    'orders.read',
    'orders.shipping-method.read',
    'orders.shipping-method.write',
  ],
  granted: [
    'orders.read',
    'orders.shipping-method.read',
    'orders.shipping-method.write',
  ],
  status: 'active',
  version: 2,
  credentialVersion: 1,
  createdAt: '2026-09-18T00:00:00Z',
  updatedAt: '2026-09-18T01:00:00Z',
};

function render(
  connection: InstalledConnection,
  { canManage = true, owner = false } = {},
) {
  return renderToStaticMarkup(
    <ConnectionCard
      connection={connection}
      organizationId={fixture.tenantId}
      canManage={canManage}
      owner={owner}
      refresh={async () => {}}
    />,
  );
}

it('splits the requested and confirmed intersection into reads and changes', () => {
  const html = render(fixture);
  expect(html).toContain('Read and write');
  expect(html).toContain('2 reads · 1 change');
  expect(html).toContain('Correct shipping methods');
  expect(html).not.toContain('Not in use');
  const readOnly = render({ ...fixture, permissions: ['orders.read'] });
  expect(readOnly).toContain('Read-only');
  expect(readOnly).not.toContain('Correct shipping methods');
  expect(html).not.toContain('View Data sync');
  expect(html).not.toContain(fixture.updatedAt);
});

it('names the account a connection reaches with labelled target details', () => {
  const html = render(fixture);
  expect(html).toContain('JTL Cloud');
  expect(html).toContain('Tenant ID');
  expect(html).toContain(fixture.target.jtlTenantId);
});

it.each(['pending', 'degraded', 'disconnected', 'revoked'] as const)(
  'never enables capabilities in the %s state',
  (status) => {
    const html = render({ ...fixture, status });
    expect(html).not.toContain('Read and write');
    expect(html).not.toContain('>Reads<');
    if (status === 'disconnected') expect(html).not.toContain('<button');
    else expect(html).toContain('None yet');
  },
);

it('asks for validation before a pending connection reports an import', () => {
  const html = render({
    ...fixture,
    status: 'pending',
    granted: [],
    coverage: {
      health: 'importing',
      lastObservedAt: null,
      freshness: 'unobserved',
    },
  });
  expect(html).toContain('Awaiting validation');
  expect(html).not.toContain('Importing');
  expect(html).toContain('Luma uses these after it validates the connection.');
  expect(html).toContain('Validate access');
});

it('shows each stream’s last read, failures and open issues', () => {
  const html = render({
    ...fixture,
    status: 'degraded',
    coverage: {
      health: 'failing',
      lastObservedAt: '2026-09-18T00:30:00Z',
      freshness: 'stale',
      streams: [
        {
          recordType: 'orders',
          lastSuccessfulAt: '2026-09-18T00:30:00Z',
          lastError: 'ACCESS_DENIED',
          issueIds: ['44444444-4444-4444-8444-444444444444'],
        },
      ],
    },
  });
  expect(html).toContain('Read failing');
  expect(html).toContain('Orders');
  expect(html).toContain('Open connection issue');
  // Missing permissions are the likely cause, so they show without another click.
  expect(html).toMatch(/<details open=""[^>]*connection-permissions/);
});

it('shows members capability information without management controls', () => {
  const html = render(fixture, { canManage: false });
  expect(html).toContain('Read and write');
  expect(html).not.toContain('<button');
});

it('offers to reconnect a connection the provider revoked', () => {
  const html = render({
    ...fixture,
    target: { kind: 'shopify', shop: 'dev.myshopify.com' },
    appId: 'shopify',
    status: 'revoked',
  });
  expect(html).toContain('Access revoked');
  expect(html).toContain('>Reconnect<');
  expect(html).toContain('Actions for Warehouse');
  expect(html).not.toContain('Replace credentials');
  expect(html).not.toContain('Validate access');
});

it('shows the history only to people who may read connection events', () => {
  expect(render(fixture)).not.toContain('>History<');
  expect(
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionCard
          connection={fixture}
          organizationId={fixture.tenantId}
          canManage
          canReadHistory
          refresh={async () => {}}
        />
      </QueryClientProvider>,
    ),
  ).toContain('>History<');
});
