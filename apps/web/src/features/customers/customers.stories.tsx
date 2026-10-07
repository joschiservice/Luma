import type {
  CustomerDetail,
  CustomerList,
  CustomerListItem,
} from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { type ComponentType, lazy, Suspense, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import type { CustomersSearch } from './data';
import { CustomerDetailView } from './detail';
import { CustomersView } from './page';

const modules = import.meta.glob<{ default: ComponentType<AppUiProps> }>(
  '../../../../../packages/apps/*/src/web/index.tsx',
);
const load = Object.entries(modules).find(([path]) =>
  path.includes('/shopify/'),
)?.[1];
const Shopify = load ? lazy(load) : null;
const organizationId = '22222222-2222-4222-8222-222222222222';
const tokyo = '11111111-1111-4111-8111-111111111111';
const vienna = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-09-28T08:00:00.000Z';

const source = (connectionId: string, label: string) => ({
  connectionId,
  label,
  system: 'shopify',
  appId: 'shopify',
  status: 'active',
  access: 'granted' as const,
  records: 2,
  importing: false,
  fullReadAt: timestamp,
  lastReadAt: timestamp,
  failing: false,
});

const customer = (
  id: number,
  patch: Partial<CustomerListItem> = {},
): CustomerListItem => ({
  id: `00000000-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`,
  connectionId: tokyo,
  externalId: `gid://shopify/Customer/${id}`,
  displayName: 'Avery Tan',
  email: 'avery@example.test',
  phone: '+81 3 1234 5678',
  state: 'enabled',
  sourceCreatedAt: '2025-03-14T09:30:00.000Z',
  orderCount: 8,
  amountSpent: { amount: '482', currency: 'EUR' },
  tags: ['VIP', 'Wholesale'],
  shared: { contact: true, address: true },
  sourceUpdatedAt: timestamp,
  observedAt: timestamp,
  ...patch,
});

const list: CustomerList = {
  items: [
    customer(71),
    customer(72, {
      displayName: 'Jonas Weber',
      email: 'jonas@example.test',
      connectionId: vienna,
      state: 'disabled',
      orderCount: 1,
      amountSpent: { amount: '39.9', currency: 'EUR' },
      tags: [],
    }),
    customer(73, {
      displayName: null,
      email: null,
      phone: null,
      shared: { contact: false, address: false },
      state: 'unknown',
      orderCount: 3,
      sourceCreatedAt: null,
    }),
  ],
  sources: [source(tokyo, 'Tokyo store'), source(vienna, 'Vienna store')],
  totalCount: 3,
  nextCursor: null,
  asOf: timestamp,
};

const detail: CustomerDetail = {
  item: customer(71),
  address: {
    line1: '1-2-3 Jingumae',
    line2: null,
    city: 'Shibuya',
    region: 'Tokyo',
    postalCode: '150-0001',
    country: 'Japan',
  },
  source: source(tokyo, 'Tokyo store'),
  asOf: timestamp,
};

const order = {
  id: 'gid://shopify/Order/2001',
  sourceUpdatedAt: timestamp,
  fields: {
    Name: '#2001',
    Created: timestamp,
    Payment: 'PAID',
    Fulfillment: 'FULFILLED',
    Total: '84.00 EUR',
  },
  links: [],
};

/** Shopify's live order history slot with deterministic responses. */
function History({ denied = false }: { denied?: boolean }) {
  const services = useMemo<AppUiProps['services']>(
    () => ({
      install: async () => {
        throw new Error('Unavailable');
      },
      rotate: async () => {
        throw new Error('Unavailable');
      },
      uncertain: () => false,
      error: () => 'Could not load order history. Try again.',
      orderContext: async () => ({ status: 'unmapped', order: null }),
      request: async (_path, body) => {
        const input = body as { kind: string; id: string };
        const sections = (
          input.kind === 'Order'
            ? [
                { key: 'order', title: 'Order', rows: [order] },
                { key: 'returns', title: 'Returns', rows: [] },
                { key: 'refunds', title: 'Refunds', rows: [] },
              ]
            : [{ key: 'orders', title: 'Customer orders', rows: [order] }]
        ).map((section) =>
          denied && section.key === 'orders'
            ? {
                ...section,
                rows: [],
                status: 'missing_scope',
                message: 'Reconnect Shopify with read_orders.',
                requiredScopes: ['read_orders'],
              }
            : {
                ...section,
                status: 'available',
                message: null,
                requiredScopes: [],
              },
        );

        return {
          tenantId: organizationId,
          connectionId: tokyo,
          kind: input.kind,
          id: input.id,
          shop: 'tokyo.myshopify.com',
          observedAt: timestamp,
          apiVersion: '2026-07',
          sections,
          nextCursor: null,
        };
      },
    }),
    [denied],
  );
  if (!Shopify) return null;

  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Shopify
        organizationId={organizationId}
        slot="customers"
        can={() => true}
        customer={{ connectionId: tokyo, id: detail.item.externalId }}
        services={services}
        done={async () => {}}
      />
    </Suspense>
  );
}

function Content({ state }: { state: string }) {
  const [search, change] = useState<CustomersSearch>({});
  const [q, setQ] = useState('');
  if (state === 'detail' || state === 'withheld' || state === 'denied')
    return (
      <CustomerDetailView
        organizationId={organizationId}
        detail={
          state === 'withheld'
            ? {
                ...detail,
                item: list.items[2]!,
                address: null,
              }
            : detail
        }
        refresh={() => {}}
        history={<History denied={state === 'denied'} />}
      />
    );
  if (state === 'not-found')
    return (
      <CustomerDetailView
        organizationId={organizationId}
        error="missing"
        refresh={() => {}}
      />
    );
  const items = q
    ? list.items.filter((item) =>
        `${item.displayName} ${item.email}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      )
    : list.items;

  return (
    <CustomersView
      organizationId={organizationId}
      search={search}
      q={q}
      setQ={setQ}
      change={change}
      refresh={() => {}}
      page={1}
      unresolved={state === 'unresolved'}
      list={
        state === 'loading' || state === 'error'
          ? undefined
          : state === 'not-shared'
            ? {
                ...list,
                items: [],
                totalCount: 0,
                sources: list.sources.map((item) => ({
                  ...item,
                  access: 'not_requested' as const,
                  records: 0,
                })),
              }
            : { ...list, items, totalCount: items.length }
      }
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={state === 'error' ? 'Customers could not be loaded.' : undefined}
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
  title: 'Customers/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Browse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Avery Tan' }),
    ).toBeVisible();
    // Each store's customers stay separate, so the source is named with the customer.
    await expect(
      canvas.getByText('jonas@example.test · Vienna store'),
    ).toBeVisible();
    // Without shared contact details the customer is named by source ID only.
    await expect(
      canvas.getByRole('link', { name: 'Customer 73' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('Contact details not shared · Tokyo store'),
    ).toBeVisible();
    await userEvent.type(
      canvas.getByRole('searchbox', { name: 'Search customers' }),
      'jonas{Enter}',
    );
    await expect(
      await canvas.findByRole('link', { name: 'Jonas Weber' }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: 'Avery Tan' }),
    ).not.toBeInTheDocument();
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
      await canvas.findByRole('heading', { name: 'Avery Tan', level: 1 }),
    ).toBeVisible();
    await expect(canvas.getByText('150-0001 Shibuya')).toBeVisible();
    await userEvent.click(
      await canvas.findByRole('button', { name: '#2001' }, { timeout: 10000 }),
    );
    await expect(
      await canvas.findByText(/has not been mapped/, undefined, {
        timeout: 10000,
      }),
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

export const ContactWithheld: Story = {
  args: { state: 'withheld' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Customer 73', level: 1 }),
    ).toBeVisible();
    await expect(canvas.getAllByText('Not shared')).toHaveLength(3);
  },
};

export const HistoryDenied: Story = {
  args: { state: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        'Reconnect Shopify with read_orders.',
        undefined,
        { timeout: 10000 },
      ),
    ).toBeVisible();
  },
};

export const NotImported: Story = { args: { state: 'unresolved' } };

export const NotShared: Story = { args: { state: 'not-shared' } };

export const NotFound: Story = { args: { state: 'not-found' } };

export const Loading: Story = { args: { state: 'loading' } };

export const LoadError: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
