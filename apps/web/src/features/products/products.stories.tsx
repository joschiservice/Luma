import type {
  CatalogItem,
  CatalogListing,
  CatalogSource,
  ProductDetail,
  ProductList,
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
import { customFieldText } from '../adaptive/presentation';
import { IdentityLinksView } from '../sync/identity-links';
import { listingColumn, productGroupLabel } from './collection';
import { productOptions } from './data';
import { ProductDetailView } from './detail';
import { ProductsEmpty, ProductsView, ProductTabs } from './page';
import { ProductPreview } from './preview';
import { ProductResults } from './results';

const org = '33333333-3333-4333-8333-333333333333';
const store = '66666666-6666-4666-8666-666666666666';
const erp = '55555555-5555-4555-8555-555555555555';
const asOf = '2026-09-30T09:00:00Z';

const sources: CatalogSource[] = [
  {
    connectionId: erp,
    label: 'JTL-Wawi',
    system: 'jtl-onprem',
    status: 'active',
    skuCount: 412,
    fullReadAt: '2026-09-30T02:00:00Z',
    lastReadAt: '2026-09-30T08:55:00Z',
    failing: false,
  },
  {
    connectionId: store,
    label: 'Shopify · EU store',
    system: 'shopify',
    status: 'active',
    skuCount: 398,
    fullReadAt: '2026-09-30T03:10:00Z',
    lastReadAt: '2026-09-30T08:58:00Z',
    failing: false,
  },
];

const listing = (
  connectionId: string,
  patch: Partial<CatalogListing>,
): CatalogListing => ({
  connectionId,
  productId: '99999999-9999-4999-8999-999999999999',
  externalProduct: connectionId === store ? 'gid://shopify/Product/81' : '81',
  externalSku:
    connectionId === store ? 'gid://shopify/InventoryItem/4410' : '81',
  code: 'LINEN-SHIRT-M',
  productTitle: 'Linen shirt',
  variantTitle: connectionId === store ? 'M' : null,
  status: 'active',
  published: true,
  vendor: 'Harbor Linen',
  barcode: '4006381333931',
  price:
    connectionId === store
      ? { amount: '49.00', currency: 'EUR' }
      : { amount: '49.00', currency: null },
  unit: 'each',
  observedAt: '2026-09-30T08:40:00Z',
  sourceUpdatedAt: '2026-09-29T17:12:00Z',
  ...patch,
});

const shirt: CatalogItem = {
  skuId: '22222222-2222-4222-8222-222222222222',
  sku: 'LINEN-SHIRT-M',
  skuKey: 'LINEN-SHIRT-M',
  title: 'Linen shirt · M',
  differences: ['status', 'published'],
  gaps: [],
  listings: [
    listing(store, {}),
    listing(erp, {
      productTitle: 'Leinenhemd M',
      status: 'archived',
      published: false,
    }),
  ],
};

const items: CatalogItem[] = [
  {
    skuId: '10000000-0000-4000-8000-000000000001',
    sku: 'APRON-S',
    skuKey: 'APRON-S',
    title: 'Linen apron · Small',
    differences: [],
    gaps: [],
    listings: [
      listing(store, {
        code: 'APRON-S',
        productTitle: 'Linen apron',
        variantTitle: 'Small',
        price: { amount: '18.00', currency: 'EUR' },
      }),
      listing(erp, {
        code: 'APRON-S',
        productTitle: 'Linen apron Small',
        price: { amount: '18.00', currency: null },
      }),
    ],
  },
  {
    skuId: '10000000-0000-4000-8000-000000000002',
    sku: 'GIFT-BOX',
    skuKey: 'GIFT-BOX',
    title: 'Gift box',
    differences: [],
    gaps: [
      {
        connectionId: erp,
        match: {
          skuId: '10000000-0000-4000-8000-000000000009',
          sku: 'gift-box',
        },
      },
    ],
    listings: [
      listing(store, {
        code: 'GIFT-BOX',
        productTitle: 'Gift box',
        variantTitle: null,
        price: { amount: '4.50', currency: 'EUR' },
      }),
    ],
  },
  shirt,
  {
    skuId: '10000000-0000-4000-8000-000000000003',
    sku: 'SCARF-WOOL',
    skuKey: 'SCARF-WOOL',
    title: 'Wool scarf',
    differences: [],
    gaps: [{ connectionId: erp, match: null }],
    listings: [
      listing(store, {
        code: 'SCARF-WOOL',
        productTitle: 'Wool scarf',
        variantTitle: null,
        status: 'draft',
        published: false,
        price: { amount: '39.00', currency: 'EUR' },
      }),
    ],
  },
];

const list: ProductList = {
  items,
  sources,
  counts: { all: 4, differs: 1, missing: 2, unlinked: 1 },
  nextCursor: 'next',
  asOf,
};

const day = (offset: number) =>
  new Date(Date.parse('2026-08-31T00:00:00Z') + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);

const detail: ProductDetail = {
  item: shirt,
  sources,
  asOf,
  variants: [
    {
      skuId: '10000000-0000-4000-8000-000000000010',
      sku: 'LINEN-SHIRT-S',
      title: 'S',
      connectionId: store,
      status: 'active',
    },
    {
      skuId: '10000000-0000-4000-8000-000000000011',
      sku: 'LINEN-SHIRT-L',
      title: 'L',
      connectionId: store,
      status: 'active',
    },
  ],
  history: {
    entries: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        connectionId: erp,
        current: true,
        deleted: false,
        observedAt: '2026-09-30T08:40:00Z',
        sourceUpdatedAt: '2026-09-29T17:12:00Z',
        productTitle: 'Leinenhemd M',
        status: 'archived',
        published: false,
        price: { amount: '49.00', currency: null },
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        connectionId: store,
        current: true,
        deleted: false,
        observedAt: '2026-09-30T08:40:00Z',
        sourceUpdatedAt: '2026-09-29T09:00:00Z',
        productTitle: 'Linen shirt',
        status: 'active',
        published: true,
        price: { amount: '49.00', currency: 'EUR' },
      },
      {
        id: '20000000-0000-4000-8000-000000000003',
        connectionId: store,
        current: false,
        deleted: false,
        observedAt: '2026-09-21T08:40:00Z',
        sourceUpdatedAt: '2026-09-20T09:00:00Z',
        productTitle: 'Linen shirt',
        status: 'active',
        published: true,
        price: { amount: '45.00', currency: 'EUR' },
      },
    ],
    truncated: false,
  },
  stock: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      skuId: shirt.skuId,
      sku: 'LINEN-SHIRT-M',
      skuKey: 'LINEN-SHIRT-M',
      locationId: '44444444-4444-4444-8444-444444444444',
      location: 'Berlin warehouse',
      unit: 'each',
      differences: ['available'],
      sync: null,
      sources: [
        {
          connectionId: erp,
          label: 'JTL-Wawi',
          status: 'active',
          externalSku: '81',
          externalLocation: 'all-warehouses',
          mappingMethod:
            'Linked by a person as the same record in another source',
          onHand: '24',
          reserved: '6',
          available: '18',
          incoming: null,
          availabilityBasis: 'provider_reported',
          observedAt: '2026-09-30T08:40:00Z',
          sourceUpdatedAt: '2026-09-30T08:30:00Z',
          deleted: false,
        },
        {
          connectionId: store,
          label: 'Shopify · EU store',
          status: 'active',
          externalSku: 'gid://shopify/InventoryItem/4410',
          externalLocation: 'gid://shopify/Location/1',
          mappingMethod:
            'Linked by a person as the same record in another source',
          onHand: '21',
          reserved: '0',
          available: '21',
          incoming: null,
          availabilityBasis: 'provider_reported',
          observedAt: '2026-09-30T08:40:00Z',
          sourceUpdatedAt: '2026-09-30T08:20:00Z',
          deleted: false,
        },
      ],
    },
  ],
  sales: {
    since: '2026-08-31T00:00:00.000Z',
    sources: [
      {
        connectionId: store,
        unit: 'each',
        orders: 14,
        quantity: '19',
        lastPlacedAt: '2026-09-29T15:02:00Z',
        daily: [2, 5, 6, 9, 12, 13, 16, 19, 22, 23, 26, 28, 29].map(
          (offset, index) => ({
            date: day(offset),
            quantity: String(index % 4 === 0 ? 3 : 1),
          }),
        ),
      },
      {
        connectionId: erp,
        unit: 'each',
        orders: 3,
        quantity: '5',
        lastPlacedAt: '2026-09-27T09:44:00Z',
        daily: [
          { date: day(4), quantity: '2' },
          { date: day(17), quantity: '1' },
          { date: day(27), quantity: '2' },
        ],
      },
    ],
  },
  orders: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      label: '#1042',
      status: 'open',
      connectionId: store,
      quantity: '2',
      unit: 'each',
      placedAt: '2026-09-29T15:02:00Z',
    },
    {
      id: '77777777-7777-4777-8777-777777777778',
      label: 'AU-20931',
      status: 'completed',
      connectionId: erp,
      quantity: '1',
      unit: 'each',
      placedAt: '2026-09-27T09:44:00Z',
    },
  ],
  purchaseOrders: [
    {
      id: '88888888-8888-4888-8888-888888888881',
      label: 'PO-2026-118',
      status: 'submitted',
      quantity: 60,
      unit: 'each',
    },
  ],
  issues: [],
  relatedTruncated: false,
};

const missingDetail: ProductDetail = {
  ...detail,
  item: items[1]!,
  variants: [],
  stock: [],
  sales: { since: detail.sales.since, sources: [] },
  orders: [],
  purchaseOrders: [],
  history: { entries: [], truncated: false },
};

const identity = (
  <IdentityLinksView
    submit={() => {}}
    detail={{
      entity: { id: shirt.skuId, kind: 'sku', label: 'LINEN-SHIRT-M' },
      canManage: true,
      requests: [],
      sources: [
        {
          connectionId: store,
          connectionLabel: 'Shopify · EU store',
          provider: 'shopify',
          externalId: 'gid://shopify/InventoryItem/4410',
          scopeKey: '',
          method: 'Linked by a person as the same record in another source',
          linkedAt: '2026-09-28T09:00:00Z',
          revisedAt: null,
          codes: ['LINEN-SHIRT-M'],
          titles: ['Linen shirt'],
        },
        {
          connectionId: erp,
          connectionLabel: 'JTL-Wawi',
          provider: 'jtl',
          externalId: '81',
          scopeKey: '',
          method: 'Linked by a person as the same record in another source',
          linkedAt: '2026-09-28T09:05:00Z',
          revisedAt: null,
          codes: ['LINEN-SHIRT-M'],
          titles: ['Leinenhemd M'],
        },
      ],
      suggestions: [],
    }}
  />
);

function Content({ state }: { state: string }) {
  if (
    state === 'detail' ||
    state === 'missing' ||
    state === 'bundle' ||
    state === 'bundle-unknown'
  )
    return (
      <ProductDetailView
        organizationId={org}
        detail={
          state === 'missing'
            ? missingDetail
            : state.startsWith('bundle')
              ? {
                  ...detail,
                  bundles: [
                    {
                      connectionId: store,
                      productId: shirt.listings[0]!.productId,
                      variant: {
                        externalId: 'gid://shopify/ProductVariant/4400',
                        scopeKey: '',
                      },
                      requiresComponents: true,
                      observedAt: asOf,
                      sourceUpdatedAt: null,
                      components:
                        state === 'bundle-unknown'
                          ? null
                          : [
                              {
                                sourceId: {
                                  externalId:
                                    'gid://shopify/ProductVariantComponent/101',
                                  scopeKey: '',
                                },
                                sourceVariant: {
                                  externalId:
                                    'gid://shopify/ProductVariant/4410',
                                  scopeKey: '',
                                },
                                sourceSku: {
                                  externalId:
                                    'gid://shopify/InventoryItem/4499',
                                  scopeKey: '',
                                },
                                skuId: shirt.skuId,
                                quantity: '2',
                              },
                            ],
                    },
                  ],
                }
              : detail
        }
        refresh={() => {}}
        identity={state === 'detail' ? identity : null}
      />
    );
  if (state === 'not-found')
    return (
      <ProductDetailView
        organizationId={org}
        error="missing"
        refresh={() => {}}
      />
    );

  return <ListPreview state={state} />;
}

const groupedList: ProductList = {
  ...list,
  nextCursor: null,
  groups: [
    {
      key: 'active',
      count: 4,
      complete: true,
      itemIds: items.slice(0, 3).map((item) => item.skuId),
      nextCursor: 'group-next',
      sums: [],
    },
    {
      key: 'draft',
      count: 1,
      complete: true,
      itemIds: [items[3]!.skuId],
      nextCursor: null,
      sums: [],
    },
  ],
};

/** A custom product field column and an archived one, as a view shows them. */
const customColumns = [
  {
    key: 'custom:season',
    header: 'Season',
    cell: (item: CatalogItem) =>
      customFieldText(
        {
          type: 'enum',
          options: [{ value: 'summer', label: 'Summer' }],
        },
        item.skuId === items[0]!.skuId ? 'summer' : undefined,
      ),
  },
  {
    key: 'custom:legacy',
    header: 'Legacy code',
    cell: () => m.collections_field_archived(),
  },
];

/** The list page as the route renders it, with fixed rows and local view state. */
function ListPreview({ state }: { state: string }) {
  const [segment, setSegment] = useState(
    state === 'no-matches' ? 'differs' : 'all',
  );
  const [sort, setSort] = useState<DataTableSort | undefined>();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | undefined>(
    state === 'preview' ? shirt.skuId : undefined,
  );
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(productOptions(org, shirt.skuId).queryKey, detail);

    return queryClient;
  });
  const shown =
    state === 'empty'
      ? {
          ...list,
          items: [],
          sources: [],
          counts: { all: 0, differs: 0, missing: 0, unlinked: 0 },
          nextCursor: null,
        }
      : state === 'no-matches'
        ? {
            ...list,
            items: [],
            counts: { ...list.counts, differs: 0 },
            nextCursor: null,
          }
        : state === 'grouped'
          ? groupedList
          : list;
  const grouping =
    state === 'grouped' ? { field: 'status', showEmpty: false } : null;
  const error: CollectionError | undefined =
    state === 'error'
      ? { kind: 'unavailable' }
      : state === 'repair'
        ? { kind: 'invalid', message: m.collections_needs_repair() }
        : undefined;
  const hidden = ['loading', 'error', 'repair'].includes(state);
  const link = (item: CatalogItem) => (
    <a
      href={`#product-${item.skuId}`}
      onClick={(event) => {
        if (state !== 'preview') return;
        event.preventDefault();
        setOpen(item.skuId);
      }}
    />
  );
  const openItem = shown.items.find((item) => item.skuId === open);

  return (
    <QueryClientProvider client={client}>
      <ProductsView
        toolbar={
          <CollectionToolbar
            views={
              <ProductTabs
                value={segment}
                counts={hidden ? undefined : shown.counts}
                onChange={setSegment}
              />
            }
            search={{
              value: undefined,
              onChange: () => {},
              label: m.products_list_search_label(),
              placeholder: m.products_list_search_placeholder(),
            }}
            sort={{
              value: sort?.key ?? 'rank',
              options: [
                { value: 'rank', label: 'Catalog order' },
                { value: 'price', label: 'Price' },
              ],
              onChange: (key) =>
                setSort(key === 'rank' ? undefined : { key, direction: 'asc' }),
              ...(sort
                ? {
                    direction: sort.direction,
                    onDirectionChange: (direction: 'asc' | 'desc') =>
                      setSort({ ...sort, direction }),
                  }
                : {}),
            }}
            onRefresh={() => {}}
          />
        }
        note={m.products_list_note()}
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
            <ProductResults
              list={shown}
              layout={state === 'rows' ? 'list' : 'table'}
              density="comfortable"
              grouping={grouping}
              caption="All SKUs. Sorted by: Catalog order"
              link={link}
              matchLink={(_, text) => <a href="#match">{text}</a>}
              empty={
                <ProductsEmpty
                  organizationId={org}
                  segment={segment}
                  filtered={false}
                  clear={() => {}}
                />
              }
              sort={sort}
              onSortChange={setSort}
              columnState={{
                columns: [
                  'sku',
                  ...shown.sources.map((source) =>
                    listingColumn(source.connectionId),
                  ),
                  ...(state === 'custom'
                    ? customColumns.map((column) => column.key)
                    : []),
                ].map((key) => ({ key })),
              }}
              extraColumns={state === 'custom' ? customColumns : []}
              onColumnStateChange={() => {}}
              properties={['status', 'price', 'listings', 'differences']}
              current={open}
              selection={{ selected, onChange: setSelected }}
              groupLabel={(key) => productGroupLabel('status', undefined, key)}
              more={(group) => ({
                rows: [],
                load: group.nextCursor ? () => {} : undefined,
                pending: false,
                failed: false,
              })}
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
              totalCount={shown.counts.all}
              page={1}
              pageSize={50}
              hasNext={!!shown.nextCursor}
              onNext={() => {}}
              formatTotal={(count) =>
                m.products_list_pagination_total({ count })
              }
              label={m.products_list_pagination_label()}
            />
          ) : null
        }
        preview={
          state === 'preview'
            ? {
                open: !!openItem,
                title: openItem?.sku,
                content: openItem ? (
                  <ProductPreview
                    organizationId={org}
                    skuId={openItem.skuId}
                    item={openItem}
                    sources={shown.sources}
                    asOf={asOf}
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
  title: 'Products/Workspace',
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
    await expect(
      canvas.getByRole('link', { name: 'Same code, not linked: gift-box' }),
    ).toBeVisible();
    await expect(canvas.getAllByText('Not in catalog')).toHaveLength(2);
    await userEvent.click(
      canvas.getByRole('tab', { name: /Differs by source/ }),
    );
    await expect(
      canvas.getByRole('tab', { name: /Differs by source/ }),
    ).toHaveAttribute('aria-selected', 'true');
  },
};

export const Rows: Story = {
  args: { state: 'rows' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: /All SKUs/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: /LINEN-SHIRT-M/ }),
    ).toBeVisible();
  },
};

export const GroupedByStatus: Story = {
  args: { state: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: /^Active/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      canvas.getByRole('button', { name: 'Show more in Active' }),
    ).toBeVisible();
  },
};

export const OpenPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole('region', {
      name: 'Product preview',
    });
    await expect(
      within(preview).getByRole('heading', { name: 'Listings by source' }),
    ).toBeVisible();
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

export const CustomFields: Story = {
  args: { state: 'custom' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('columnheader', { name: /Season/ }),
    ).toBeVisible();
    await expect(canvas.getByText('Summer')).toBeVisible();
    await expect(
      canvas.getAllByText('This field was archived.').length,
    ).toBeGreaterThan(0);
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Detail: Story = {
  args: { state: 'detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Same SKU. Different listings.'),
    ).toBeVisible();
    await expect(
      canvas.getByRole('table', { name: 'Listing comparison by source' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('img', { name: /Shopify · EU store: 19 units/ }),
    ).toBeVisible();
  },
};

export const DetailDark: Story = {
  args: { state: 'detail' },
  globals: { theme: 'dark' },
};

export const DetailNarrow: Story = {
  args: { state: 'detail' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const MissingFromSource: Story = {
  args: { state: 'missing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Compare gift-box' }),
    ).toBeVisible();
  },
};

export const NotFound: Story = { args: { state: 'not-found' } };

export const Empty: Story = { args: { state: 'empty' } };

export const NoMatches: Story = { args: { state: 'no-matches' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };

export const Bundle: Story = { args: { state: 'bundle' } };

export const BundleDark: Story = {
  args: { state: 'bundle' },
  globals: { theme: 'dark' },
};

export const BundleUnknown: Story = { args: { state: 'bundle-unknown' } };
