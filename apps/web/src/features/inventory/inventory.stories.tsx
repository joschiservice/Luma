import type {
  InventoryDetail,
  InventoryList,
  StockPosition,
} from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import type { InventorySearch } from './data';
import { StockDetailView } from './detail';
import { InventoryView } from './page';

const org = '33333333-3333-4333-8333-333333333333';
const position: StockPosition = {
  id: '11111111-1111-4111-8111-111111111111',
  skuId: '22222222-2222-4222-8222-222222222222',
  sku: 'LINEN-SHIRT-M',
  locationId: '44444444-4444-4444-8444-444444444444',
  location: 'Tokyo warehouse',
  unit: 'each',
  differences: ['available'],
  sources: [
    {
      connectionId: '55555555-5555-4555-8555-555555555555',
      label: 'JTL-Wawi',
      status: 'active',
      externalSku: '77',
      externalLocation: 'Tokyo warehouse',
      mappingMethod: 'operator-confirmed',
      onHand: '24',
      reserved: '6',
      available: '18',
      incoming: null,
      availabilityBasis: 'derived',
      observedAt: '2026-09-29T08:59:00Z',
      sourceUpdatedAt: '2026-09-29T08:58:00Z',
      deleted: false,
    },
    {
      connectionId: '66666666-6666-4666-8666-666666666666',
      label: 'Shopify · Japan',
      status: 'active',
      externalSku: 'LINEN-SHIRT-M',
      externalLocation: 'Tokyo warehouse',
      mappingMethod: 'operator-confirmed',
      onHand: null,
      reserved: null,
      available: '24',
      incoming: null,
      availabilityBasis: 'provider_reported',
      observedAt: '2026-09-29T06:00:00Z',
      sourceUpdatedAt: null,
      deleted: false,
    },
  ],
};
const list: InventoryList = {
  items: [position],
  nextCursor: null,
  asOf: '2026-09-29T09:00:00Z',
};
const detail: InventoryDetail = {
  position,
  asOf: list.asOf,
  relatedTruncated: false,
  history: {
    entries: position.sources.map((source, i) => ({
      ...source,
      id: String(i),
      current: true,
    })),
    truncated: false,
  },
  orders: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      label: '#1042',
      status: 'open',
      connectionId: position.sources[0]!.connectionId,
      quantity: '2',
      unit: 'each',
    },
  ],
  purchaseOrders: [],
  issues: [],
};

function Content({ state }: { state: string }) {
  const [search, change] = useState<InventorySearch>({});
  if (state === 'detail')
    return (
      <StockDetailView
        organizationId={org}
        detail={detail}
        refresh={() => {}}
      />
    );

  return (
    <InventoryView
      organizationId={org}
      search={search}
      change={change}
      refresh={() => {}}
      list={
        state === 'loading' || state === 'error'
          ? undefined
          : state === 'empty'
            ? { ...list, items: [] }
            : list
      }
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={state === 'error' ? 'Inventory could not be loaded.' : undefined}
    />
  );
}

function Preview({ state = 'list' }: { state?: string }) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <Content state={state} />
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Inventory/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Browse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'LINEN-SHIRT-M' }),
    ).toBeVisible();
    await expect(canvas.getByText('Differs by source')).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Detail: Story = { args: { state: 'detail' } };

export const DetailDark: Story = {
  args: { state: 'detail' },
  globals: { theme: 'dark' },
};

export const Empty: Story = { args: { state: 'empty' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
