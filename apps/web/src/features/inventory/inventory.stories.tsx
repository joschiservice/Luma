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
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { IdentityLinksView } from '../sync/identity-links';
import type { InventorySearch } from './data';
import { StockDetailView } from './detail';
import { InventoryView } from './page';

const org = '33333333-3333-4333-8333-333333333333';
const position: StockPosition = {
  id: '11111111-1111-4111-8111-111111111111',
  skuId: '22222222-2222-4222-8222-222222222222',
  sku: 'LINEN-SHIRT-M',
  skuKey: 'LINEN-SHIRT-M',
  locationId: '44444444-4444-4444-8444-444444444444',
  location: 'Tokyo warehouse',
  unit: 'each',
  differences: ['available'],
  sync: null,
  sources: [
    {
      connectionId: '55555555-5555-4555-8555-555555555555',
      label: 'JTL-Wawi',
      status: 'active',
      externalSku: '77',
      externalLocation: 'Tokyo warehouse',
      mappingMethod: 'Linked by a person as the same record in another source',
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
      mappingMethod: 'Linked by a person as the same record in another source',
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
const providerStates: StockPosition = {
  ...position,
  differences: ['onHand', 'available'],
  sources: position.sources.map((source) =>
    source.label.startsWith('Shopify')
      ? {
          ...source,
          onHand: '3',
          committed: '5',
          reserved: '1',
          available: '-2',
          incoming: '7',
          damaged: '0',
          qualityControl: null,
          safetyStock: '3',
          locationActive: true,
          itemActive: false,
          tracked: true,
          inventorySemantics: 'shopify/1',
        }
      : source,
  ),
};
// A gap Luma first saw a minute ago and lets the provider sync close.
const syncing: StockPosition = {
  ...position,
  sync: { since: '2026-09-29T08:59:00Z', until: '2026-09-29T09:14:00Z' },
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

const identity = (
  <IdentityLinksView
    submit={() => {}}
    detail={{
      entity: { id: position.skuId, kind: 'sku', label: 'LINEN-SHIRT-M' },
      canManage: true,
      requests: [],
      sources: [
        {
          connectionId: position.sources[1]!.connectionId,
          connectionLabel: 'Shopify · Japan',
          provider: 'shopify',
          externalId: 'gid://shopify/InventoryItem/4410',
          scopeKey: '',
          method: 'Imported source record with its own canonical identity',
          linkedAt: '2026-09-28T09:00:00Z',
          revisedAt: null,
          codes: ['LINEN-SHIRT-M'],
          titles: ['Linen shirt'],
        },
      ],
      suggestions: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          label: 'LINEN-SHIRT-M',
          reason: 'Same SKU code “linen-shirt-m”',
          sources: [
            {
              connectionId: position.sources[0]!.connectionId,
              connectionLabel: 'JTL-Wawi',
              provider: 'jtl',
              externalId: '77',
              scopeKey: '',
              method: 'Imported source record',
              linkedAt: '2026-09-28T09:00:00Z',
              revisedAt: null,
              codes: ['linen-shirt-m'],
              titles: ['Leinenhemd M'],
            },
          ],
        },
      ],
    }}
  />
);

function Content({ state }: { state: string }) {
  const [search, change] = useState<InventorySearch>({});
  if (
    state === 'detail' ||
    state === 'syncing-detail' ||
    state === 'provider-states'
  )
    return (
      <StockDetailView
        organizationId={org}
        detail={
          state === 'syncing-detail'
            ? { ...detail, position: syncing }
            : state === 'provider-states'
              ? {
                  ...detail,
                  position: providerStates,
                  history: {
                    ...detail.history,
                    entries: providerStates.sources.map((source, i) => ({
                      ...source,
                      id: String(i),
                      current: true,
                    })),
                  },
                }
              : detail
        }
        refresh={() => {}}
        identity={identity}
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
            : state === 'syncing'
              ? { ...list, items: [syncing] }
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

export const Detail: Story = {
  args: { state: 'detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Possibly the same SKU'),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Link' })).toBeVisible();
  },
};

export const DetailDark: Story = {
  args: { state: 'detail' },
  globals: { theme: 'dark' },
};

/** A gap that provider sync is expected to close is shown as syncing, not as a difference. */
export const Syncing: Story = {
  args: { state: 'syncing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Syncing')).toBeVisible();
    await expect(canvas.queryByText('Differs by source')).toBeNull();
  },
};

export const SyncingDetail: Story = {
  args: { state: 'syncing-detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Same position. Waiting for sync.',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByText(/If it is still open at .+, Luma raises an issue\./),
    ).toBeVisible();
  },
};

export const SyncingDetailDark: Story = {
  args: { state: 'syncing-detail' },
  globals: { theme: 'dark' },
};

export const Empty: Story = { args: { state: 'empty' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };

/** Distinct provider states retain zero, unknown, negative stock and inactive item eligibility. */
export const ProviderStates: Story = {
  args: { state: 'provider-states' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByText('Unavailable stock and activation', {
        selector: 'summary',
      }),
    );
    const states = canvas.getByRole('table', {
      name: 'Unavailable stock and activation',
    });
    await expect(states).toBeVisible();
    await expect(within(states).getByText('No')).toBeVisible();
    await expect(
      within(states).getAllByText('Not reported').length,
    ).toBeGreaterThan(0);
  },
};

export const ProviderStatesDark: Story = {
  ...ProviderStates,
  globals: { theme: 'dark' },
};
