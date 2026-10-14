import type {
  InventoryDetail,
  InventoryList,
  StockPosition,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { CollectionToolbar } from '@luma/ui/components/primitives/collection-toolbar';
import type { DataTableSort } from '@luma/ui/components/primitives/data-table';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { CollectionNotices } from '../../kit/collections/notices';
import type { CollectionError } from '../../kit/collections/paging';
import appStyles from '../../styles.css?inline';
import { IdentityLinksView } from '../sync/identity-links';
import { inventoryGroupLabel } from './collection';
import { stockOptions } from './data';
import { StockDetailView } from './detail';
import { InventoryEmpty, InventoryView } from './page';
import { InventoryPreview } from './preview';
import { InventoryResults, positionLabel } from './results';

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
const attributed: StockPosition = {
  ...providerStates,
  sources: providerStates.sources.map((source) =>
    source.inventorySemantics === 'shopify/1'
      ? {
          ...source,
          writeAttribution: {
            evidenceId: '11111111-1111-4111-8111-111111111111',
            adjustmentId: 'gid://shopify/InventoryAdjustmentGroup/17',
            referenceDocumentUri:
              'luma://inventory-corrections/v0:11111111-1111-4111-8111-111111111111',
            available: '9',
            quantityMatches: false,
          },
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
  totalCount: null,
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
  if (
    state === 'detail' ||
    state === 'syncing-detail' ||
    state === 'provider-states' ||
    state === 'write-attribution'
  )
    return (
      <StockDetailView
        organizationId={org}
        detail={
          state === 'syncing-detail'
            ? { ...detail, position: syncing }
            : state === 'provider-states' || state === 'write-attribution'
              ? {
                  ...detail,
                  position:
                    state === 'write-attribution' ? attributed : providerStates,
                  history: {
                    ...detail.history,
                    entries: (state === 'write-attribution'
                      ? attributed
                      : providerStates
                    ).sources.map((source, i) => ({
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

  return <ListPreview state={state} />;
}

// The same SKU at a second location, for grouping by SKU.
const osaka: StockPosition = {
  ...position,
  id: '11111111-1111-4111-8111-111111111112',
  locationId: '44444444-4444-4444-8444-444444444445',
  location: 'Osaka store',
  differences: [],
  sources: [{ ...position.sources[1]!, available: '4' }],
};

const groupedList: InventoryList = {
  ...list,
  items: [position, osaka],
  groups: [
    {
      key: position.skuId,
      count: 2,
      complete: true,
      itemIds: [position.id, osaka.id],
      nextCursor: null,
      sums: [],
    },
  ],
};

/** The list page as the route renders it, with fixed rows and local view state. */
function ListPreview({ state }: { state: string }) {
  const [sort, setSort] = useState<DataTableSort>({
    key: 'sku',
    direction: 'asc',
  });
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | undefined>(
    state === 'preview' ? position.id : undefined,
  );
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(stockOptions(org, position.id).queryKey, detail);

    return queryClient;
  });
  const grouping =
    state === 'grouped' ? { field: 'sku', showEmpty: false } : null;
  const shown =
    state === 'empty'
      ? { ...list, items: [] }
      : state === 'syncing'
        ? { ...list, items: [syncing] }
        : grouping
          ? groupedList
          : { ...list, items: [position, osaka], totalCount: 2 };
  const error: CollectionError | undefined =
    state === 'error'
      ? { kind: 'unavailable' }
      : state === 'repair'
        ? { kind: 'invalid', message: m.collections_needs_repair() }
        : undefined;
  const hidden = ['loading', 'error', 'repair'].includes(state);
  const link = (row: StockPosition) => (
    <a
      href={`#position-${row.id}`}
      onClick={(event) => {
        if (state !== 'preview') return;
        event.preventDefault();
        setOpen(row.id);
      }}
    />
  );
  const openPosition = shown.items.find((row) => row.id === open);

  return (
    <QueryClientProvider client={client}>
      <InventoryView
        organizationId={org}
        toolbar={
          <CollectionToolbar
            search={{
              value: undefined,
              onChange: () => {},
              label: m.inventory_list_search_label(),
              placeholder: m.inventory_list_search_placeholder(),
            }}
            sort={{
              value: sort.key,
              options: [
                { value: 'sku', label: 'SKU' },
                { value: 'available', label: 'Available' },
              ],
              onChange: (key) => setSort({ ...sort, key }),
              direction: sort.direction,
              onDirectionChange: (direction) => setSort({ ...sort, direction }),
            }}
            onRefresh={() => {}}
          />
        }
        note={m.inventory_list_note()}
        notices={
          <CollectionNotices
            offline={state === 'offline'}
            error={error}
            hasRows={!hidden}
            retry={() => {}}
            firstPage={() => {}}
            repair={state === 'repair' ? () => {} : undefined}
          />
        }
        loading={state === 'loading'}
        results={
          hidden ? undefined : (
            <InventoryResults
              list={shown}
              layout={state === 'rows' ? 'list' : 'table'}
              density="comfortable"
              grouping={grouping}
              caption="All stock. Sorted by: SKU"
              link={link}
              empty={
                <InventoryEmpty
                  organizationId={org}
                  filtered={false}
                  clear={() => {}}
                />
              }
              sort={sort}
              onSortChange={setSort}
              columnState={{
                columns: [
                  'sku',
                  'sources',
                  'onHand',
                  'reserved',
                  'available',
                  'incoming',
                ].map((key) => ({ key })),
              }}
              onColumnStateChange={() => {}}
              properties={['available', 'onHand', 'sources']}
              current={open}
              selection={{ selected, onChange: setSelected }}
              groupLabel={(key) =>
                inventoryGroupLabel(
                  'sku',
                  undefined,
                  key,
                  {},
                  () => position.sku,
                )
              }
              collapsed={collapsed}
              onCollapsedChange={(id, closed) =>
                setCollapsed((current) =>
                  closed
                    ? [...current, id]
                    : current.filter((item) => item !== id),
                )
              }
            />
          )
        }
        pagination={
          !hidden && !grouping && shown.items.length ? (
            <Pagination
              count={shown.items.length}
              totalCount={shown.totalCount ?? undefined}
              page={1}
              pageSize={50}
              hasNext={!!shown.nextCursor}
              onNext={() => {}}
              formatTotal={(count) =>
                m.inventory_list_pagination_total({ count })
              }
              label={m.inventory_list_pagination_label()}
            />
          ) : null
        }
        preview={
          state === 'preview'
            ? {
                open: !!openPosition,
                title: openPosition ? positionLabel(openPosition) : undefined,
                content: openPosition ? (
                  <InventoryPreview
                    organizationId={org}
                    positionId={openPosition.id}
                    position={openPosition}
                    asOf={list.asOf}
                    filter={() => {}}
                  />
                ) : null,
                onClose: () => setOpen(undefined),
              }
            : undefined
        }
      />
    </QueryClientProvider>
  );
}

function Preview({ state = 'table' }: { state?: string }) {
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
    const links = await canvas.findAllByRole('link', { name: 'LINEN-SHIRT-M' });
    await expect(links).toHaveLength(2);
    await expect(canvas.getByText('Differs by source')).toBeVisible();
    await expect(canvas.getByText('1–2 of 2 stock positions')).toBeVisible();
  },
};

export const Rows: Story = {
  args: { state: 'rows' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: /All stock/ }),
    ).toBeVisible();
    await expect(
      canvas.getAllByText('Available: JTL-Wawi 18 · Shopify · Japan 24')[0],
    ).toBeVisible();
  },
};

/** Grouping by SKU shows one product across warehouses. */
export const GroupedBySku: Story = {
  args: { state: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: /^LINEN-SHIRT-M/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      canvas.getAllByRole('link', { name: 'LINEN-SHIRT-M' }),
    ).toHaveLength(2);
  },
};

export const OpenPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole('region', {
      name: 'Stock preview',
    });
    await expect(within(preview).getByText('#1042')).toBeVisible();
    await expect(
      within(preview).getByRole('button', { name: 'Filter by JTL-Wawi' }),
    ).toBeVisible();
  },
};

export const NeedsRepair: Story = {
  args: { state: 'repair' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', {
        name: 'Remove unsupported conditions',
      }),
    ).toBeVisible();
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

/** A known correction does not hide a later provider quantity difference. */
export const WriteAttribution: Story = {
  args: { state: 'write-attribution' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (
        await canvas.findAllByText(
          'Luma set available stock to 9. This read differs; other changes remain unattributed.',
        )
      )[0],
    ).toBeVisible();
    await expect(canvas.getByText('Differs by source')).toBeVisible();
  },
};

export const WriteAttributionDark: Story = {
  ...WriteAttribution,
  globals: { theme: 'dark' },
};
