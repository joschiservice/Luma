import type {
  CustomerDetail,
  CustomerList,
  CustomerListItem,
  OrderList,
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
import type { CustomersSearch } from './data';
import { CustomerDetailView } from './detail';
import { CustomerOrdersView } from './orders';
import { CustomersView } from './page';

const organizationId = '22222222-2222-4222-8222-222222222222';
const tokyo = '11111111-1111-4111-8111-111111111111';
const vienna = '33333333-3333-4333-8333-333333333333';
const erp = '66666666-6666-4666-8666-666666666666';
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
  missingSince: null,
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
      missingSince: '2026-10-02T03:00:00.000Z',
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

const orders: OrderList = {
  items: [
    {
      id: '44444444-4444-4444-8444-444444444401',
      displayNumber: '#2001',
      placedAt: '2026-09-20T10:15:00.000Z',
      total: { amount: '84', currency: 'EUR' },
      status: 'open',
      paymentStatus: 'paid',
      fulfillment: 'partial',
      lineCount: 2,
      open: true,
      overdue: false,
      dueAt: null,
      issueIds: ['55555555-5555-4555-8555-555555555501'],
      differs: false,
      // Linked across sources, the order appears once with both sources.
      sources: [
        {
          connectionId: tokyo,
          label: 'Tokyo store',
          system: 'shopify',
          connectionStatus: 'active',
          externalId: 'gid://shopify/Order/2001',
          selected: true,
          deleted: false,
          observedAt: timestamp,
          sourceUpdatedAt: timestamp,
        },
        {
          connectionId: erp,
          label: 'JTL-Wawi',
          system: 'jtl-onprem',
          connectionStatus: 'active',
          externalId: '1201',
          selected: false,
          deleted: false,
          observedAt: timestamp,
          sourceUpdatedAt: null,
        },
      ],
      observedAt: timestamp,
      sourceUpdatedAt: timestamp,
    },
    {
      id: '44444444-4444-4444-8444-444444444402',
      displayNumber: '#1874',
      placedAt: '2026-06-02T08:00:00.000Z',
      total: { amount: '129.5', currency: 'EUR' },
      status: 'completed',
      paymentStatus: 'paid',
      fulfillment: 'fulfilled',
      lineCount: 3,
      open: false,
      overdue: false,
      dueAt: null,
      issueIds: [],
      differs: false,
      sources: [
        {
          connectionId: tokyo,
          label: 'Tokyo store',
          system: 'shopify',
          connectionStatus: 'active',
          externalId: 'gid://shopify/Order/1874',
          selected: true,
          deleted: false,
          observedAt: timestamp,
          sourceUpdatedAt: timestamp,
        },
      ],
      observedAt: timestamp,
      sourceUpdatedAt: timestamp,
    },
  ],
  totalCount: 2,
  nextCursor: null,
  asOf: timestamp,
};

/** The customer's Luma orders in a fixed state. */
function History({ state }: { state: string }) {
  return (
    <CustomerOrdersView
      organizationId={organizationId}
      customerPath={`/app/${organizationId}/customers/${detail.item.id}`}
      state={{ sort: 'placed', direction: 'desc' }}
      list={
        state === 'denied'
          ? undefined
          : state === 'empty'
            ? { ...orders, items: [], totalCount: 0 }
            : orders
      }
      error={state === 'denied' ? 'access' : undefined}
      page={1}
      change={() => {}}
      retry={() => {}}
    />
  );
}

const jtlDetail: CustomerDetail = {
  item: customer(74, {
    connectionId: erp,
    externalId: '4711',
    displayName: 'Mia Keller (Keller GmbH)',
    email: 'mia@keller.example',
    phone: '+49 30 1234567',
    orderCount: null,
    amountSpent: null,
    tags: ['B2B'],
  }),
  address: {
    line1: 'Hauptstraße 12',
    line2: null,
    city: 'Berlin',
    region: null,
    postalCode: '10115',
    country: 'DE',
  },
  source: {
    ...source(erp, 'JTL-Wawi'),
    system: 'jtl-onprem',
    appId: 'jtl',
  },
  asOf: timestamp,
};

function Content({ state }: { state: string }) {
  const [search, change] = useState<CustomersSearch>({});
  const [q, setQ] = useState('');
  if (['detail', 'withheld', 'denied', 'empty', 'jtl', 'gone'].includes(state))
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
            : state === 'jtl'
              ? jtlDetail
              : state === 'gone'
                ? {
                    ...jtlDetail,
                    item: {
                      ...jtlDetail.item,
                      missingSince: '2026-10-02T03:00:00.000Z',
                    },
                  }
                : detail
        }
        refresh={() => {}}
        history={<History state={state} />}
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
    // A customer the source no longer has stays listed until Luma removes them.
    await expect(canvas.getByText('No longer in Vienna store')).toBeVisible();
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
    // An order linked across sources is listed once, naming both sources.
    const row = canvas.getByRole('link', { name: '#2001' }).closest('tr')!;
    await expect(within(row).getByText('JTL-Wawi')).toBeVisible();
    await expect(within(row).getByText('Needs you')).toBeVisible();
    // Opening an order returns to this customer.
    await expect(
      canvas.getByRole('link', { name: '#2001' }).getAttribute('href'),
    ).toContain('from=');
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
        'You need access to orders to see this customer’s orders.',
      ),
    ).toBeVisible();
  },
};

export const HistoryEmpty: Story = {
  args: { state: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'No orders yet' }),
    ).toBeVisible();
  },
};

export const JtlCustomer: Story = {
  args: { state: 'jtl' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Mia Keller (Keller GmbH)',
        level: 1,
      }),
    ).toBeVisible();
    // JTL reports no order count or spend, so those facts are left out.
    await expect(canvas.queryByText('Amount spent')).not.toBeInTheDocument();
  },
};

export const GoneFromSource: Story = {
  args: { state: 'gone' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/JTL-Wawi no longer has this customer/),
    ).toBeVisible();
    await expect(canvas.getByText('Missing from source since')).toBeVisible();
  },
};

export const NotImported: Story = { args: { state: 'unresolved' } };

export const NotShared: Story = { args: { state: 'not-shared' } };

export const NotFound: Story = { args: { state: 'not-found' } };

export const Loading: Story = { args: { state: 'loading' } };

export const LoadError: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
