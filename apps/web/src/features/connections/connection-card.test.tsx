import type { InstalledConnection } from '@luma/api-contract';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { ConnectionCard } from './connection-card';

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

function render(connection: InstalledConnection, canManage = true) {
  return renderToStaticMarkup(
    <ConnectionCard
      connection={connection}
      organizationId={fixture.tenantId}
      canManage={canManage}
      refresh={async () => {}}
    />,
  );
}

it('shows only the requested and granted intersection as permitted', () => {
  const html = render(fixture);
  expect(html).toContain('Read and write access');
  expect(html.match(/>Permitted</g)).toHaveLength(3);
  const readOnly = render({ ...fixture, permissions: ['orders.read'] });
  expect(readOnly).toContain('Read-only access');
  expect(readOnly).not.toContain('Correct shipping method');
  expect(html).toContain('Observation freshness is unknown');
  expect(html).not.toContain(fixture.updatedAt);
});

it.each(['pending', 'degraded', 'disconnected', 'revoked'] as const)(
  'never enables capabilities in the %s state',
  (status) => {
    const html = render({ ...fixture, status });
    expect(html).toContain('No capabilities enabled');
    expect(html).not.toContain('>Permitted<');
    if (status === 'disconnected' || status === 'revoked')
      expect(html).not.toContain('<button');
  },
);

it('shows members capability information without management controls', () => {
  const html = render(fixture, false);
  expect(html).toContain('Read and write access');
  expect(html).not.toContain('<button');
});

it('offers Shopify reconnect for revoked installations without manual credentials', () => {
  const html = render({
    ...fixture,
    target: { kind: 'shopify', shop: 'dev.myshopify.com' },
    status: 'revoked',
  });
  expect(html).toContain('Reconnect Shopify');
  expect(html).not.toContain('Replace credentials');
  expect(html).not.toContain('Validate access');
});
