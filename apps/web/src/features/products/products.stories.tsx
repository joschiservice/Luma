import type {
  CatalogItem,
  CatalogListing,
  CatalogSource,
  ProductDetail,
  ProductList,
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
import type { ProductsSearch } from './data';
import { ProductDetailView } from './detail';
import { ProductsView } from './page';

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
  const [search, change] = useState<ProductsSearch>({});
  if (state === 'detail' || state === 'missing')
    return (
      <ProductDetailView
        organizationId={org}
        detail={state === 'missing' ? missingDetail : detail}
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

  return (
    <ProductsView
      organizationId={org}
      search={state === 'no-matches' ? { view: 'differs' } : search}
      change={change}
      refresh={() => {}}
      next={() => {}}
      list={
        state === 'loading' || state === 'error'
          ? undefined
          : state === 'empty'
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
              : list
      }
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={state === 'error' ? 'Products could not be loaded.' : undefined}
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

export const Filter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Add Missing from filter' }),
    );
    await userEvent.click(
      await page.findByRole('button', { name: 'JTL-Wawi' }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Missing from filter: JTL-Wawi',
      }),
    ).toBeVisible();
    const search = canvas.getByRole('searchbox', { name: 'Search products' });
    await userEvent.type(search, 'apron{Enter}');
    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(
      canvas.queryByRole('button', { name: /^Edit Missing from filter/ }),
    ).toBeNull();
    await expect(search).toHaveValue('');
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
