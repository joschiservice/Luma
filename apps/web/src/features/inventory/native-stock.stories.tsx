import './inventory.css';

import type { InventoryDetail } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { NativeStockPool } from './native-stock';

const org = '33333333-3333-4333-8333-333333333333',
  sku = '22222222-2222-4222-8222-222222222222',
  location = '44444444-4444-4444-8444-444444444444',
  connection = '55555555-5555-4555-8555-555555555555';
const detail: InventoryDetail = {
  position: {
    id: sku,
    skuId: sku,
    sku: 'LUMA-001',
    skuKey: 'LUMA-001',
    locationId: location,
    location: 'Main warehouse',
    unit: 'each',
    sources: [
      {
        connectionId: connection,
        label: 'Luma synthetic pilot',
        status: 'active',
        externalSku: 'LUMA-001',
        externalLocation: 'Main warehouse',
        mappingMethod: 'operator-confirmed',
        onHand: '12',
        reserved: '0',
        available: '12',
        incoming: '0',
        availabilityBasis: 'provider_reported',
        observedAt: '2026-10-13T01:00:00Z',
        sourceUpdatedAt: null,
        deleted: false,
      },
    ],
    differences: [],
    sync: null,
  },
  history: { entries: [], truncated: false },
  orders: [],
  purchaseOrders: [],
  issues: [],
  asOf: '2026-10-13T01:00:00Z',
  relatedTruncated: false,
};

type State = 'owned' | 'unopened' | 'unavailable';

function mock(state: State) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      'http://localhost',
    );
    if (url.pathname.endsWith('/context'))
      return Response.json({
        tenantId: org,
        dataRegion: 'EU',
        requestId: 'story',
        actor: {
          type: 'user',
          id: org,
          initiatingUserId: org,
          sessionId: org,
          membershipId: org,
          role: {
            id: 'member',
            key: 'member',
            name: 'Member',
            builtIn: true,
            revision: 1,
          },
        },
        permissions: ['inventory.read'],
        allAppPermissions: false,
      });
    if (state === 'unavailable')
      return Response.json(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unavailable',
          requestId: 'story',
        },
        { status: 503 },
      );

    return Response.json({
      skuId: sku,
      locationId: location,
      unit: 'each',
      opened: state === 'owned',
      scope: {
        connectionId: connection,
        locationId: location,
        version: state === 'owned' ? '3' : '0',
        mode: state === 'owned' ? 'own' : 'observe',
        authorityRevision: 5,
        lastTransitionId: state === 'owned' ? org : null,
        updatedAt: state === 'owned' ? '2026-10-13T01:00:00Z' : null,
      },
      accounts:
        state === 'owned'
          ? [
              {
                id: sku,
                address: {
                  skuId: sku,
                  locationId: location,
                  unit: 'each',
                  state: 'available',
                },
                balance: '999999999999999999.123456',
                version: '9007199254740993',
              },
              {
                id: location,
                address: {
                  skuId: sku,
                  locationId: location,
                  unit: 'each',
                  state: 'reserved',
                },
                balance: '3.125001',
                version: '7',
              },
            ]
          : [],
      pendingReviews: [],
      ownershipReviews: [],
    });
  };

  return () => {
    globalThis.fetch = original;
  };
}

function PreviewState({ state }: { state: State }) {
  const [client] = useState(() => new QueryClient());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const cleanup = mock(state);
    let active = true;
    queueMicrotask(() => {
      if (active) setReady(true);
    });

    return () => {
      active = false;
      cleanup();
    };
  }, [state]);
  if (!ready) return null;

  return (
    <QueryClientProvider key={state} client={client}>
      <style>{appStyles}</style>
      <main
        className="inventory-page"
        style={{
          maxWidth: 1000,
          padding: 16,
          background: 'var(--background)',
          color: 'var(--foreground)',
          minHeight: '100vh',
        }}
      >
        <NativeStockPool organizationId={org} detail={detail} />
      </main>
    </QueryClientProvider>
  );
}

function Preview(props: { state: State }) {
  return <PreviewState key={props.state} {...props} />;
}

const meta = {
  title: 'Inventory/Native stock',
  component: Preview,
  args: { state: 'owned' },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Owned: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.findByRole('table', { name: /^Native stock$/ }),
    ).resolves.toBeVisible();
    await expect(
      canvas.getByText('999,999,999,999,999,999.123456'),
    ).toBeVisible();
  },
};

export const OwnedDark: Story = { globals: { theme: 'dark' } };

export const Unopened: Story = {
  args: { state: 'unopened' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.findByText(
        'No reviewed native opening exists for this stock pool.',
      ),
    ).resolves.toBeVisible();
    expect(canvas.queryByRole('table')).toBeNull();
  },
};

export const Unavailable: Story = { args: { state: 'unavailable' } };
