import type {
  CustomerDetail,
  CustomerList,
  CustomerListItem,
  OrderList,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
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
import { customerGroupLabel } from './collection';
import { customerOptions } from './data';
import { CustomerDetailView } from './detail';
import { customerSourceLabel } from './fields';
import { CustomerOrdersView } from './orders';
import { CustomerAccessNotices, CustomersEmpty, CustomersView } from './page';
import { CustomerPreview } from './preview';
import { CustomerResults } from './results';

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
      comparisonState: 'matching',
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
      comparisonState: 'matching',
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

type ListState =
  | 'list'
  | 'rows'
  | 'grouped'
  | 'preview'
  | 'loading'
  | 'not-shared'
  | 'unmatched'
  | 'unresolved'
  | 'error'
  | 'page'
  | 'access'
  | 'offline'
  | 'repair';

const groupedList: CustomerList = {
  ...list,
  groups: [
    {
      key: 'enabled',
      count: 28,
      complete: true,
      itemIds: [list.items[0]!.id],
      nextCursor: 'group-next',
      sums: [{ field: 'spent', currency: 'EUR', amount: '9640.00' }],
    },
    {
      key: 'disabled',
      count: 1,
      complete: false,
      itemIds: [list.items[1]!.id],
      nextCursor: null,
      sums: [{ field: 'spent', currency: 'EUR', amount: '39.90' }],
    },
    {
      key: 'unknown',
      count: 1,
      complete: true,
      itemIds: [list.items[2]!.id],
      nextCursor: null,
      sums: [],
    },
  ],
};

/** The Customers list in a fixed state, with the page's real results, preview and notices. */
function ListContent({ state }: { state: ListState }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<DataTableSort>({
    key: 'created',
    direction: 'desc',
  });
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | undefined>(
    state === 'preview' ? list.items[0]!.id : undefined,
  );
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      customerOptions(organizationId, detail.item.id).queryKey,
      detail,
    );

    return queryClient;
  });
  const grouping =
    state === 'grouped' ? { field: 'state', showEmpty: false } : null;
  const items = q
    ? list.items.filter((item) =>
        `${item.displayName} ${item.email}`
          .toLowerCase()
          .includes(q.toLowerCase()),
      )
    : list.items;
  const shown: CustomerList =
    state === 'not-shared'
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
      : state === 'unmatched'
        ? { ...list, items: [], totalCount: 0 }
        : grouping
          ? groupedList
          : { ...list, items, totalCount: items.length };
  const error: CollectionError | undefined =
    state === 'error' || state === 'access'
      ? { kind: state === 'error' ? 'unavailable' : 'access' }
      : state === 'page'
        ? {
            kind: 'page',
            message:
              'This page link no longer matches the customer filters. Start from the first page.',
          }
        : state === 'repair'
          ? { kind: 'invalid', message: m.collections_needs_repair() }
          : undefined;
  const hidden = ['loading', 'error', 'access', 'page', 'repair'].includes(
    state,
  );
  const link = (item: CustomerListItem) => (
    <a
      href={`#customer-${item.id}`}
      onClick={(event) => {
        if (state !== 'preview') return;
        event.preventDefault();
        setOpen(item.id);
      }}
    />
  );
  const openCustomer = list.items.find((item) => item.id === open);
  const sourceLabel = customerSourceLabel(list.sources);

  return (
    <QueryClientProvider client={client}>
      <CustomersView
        toolbar={
          <CollectionToolbar
            search={{
              value: state === 'unmatched' ? 'Nobody' : q || undefined,
              onChange: (value) => setQ(value ?? ''),
              label: m.customers_list_search_label(),
              placeholder: m.customers_list_search_placeholder(),
            }}
            sort={{
              value: sort.key,
              options: [
                { value: 'created', label: m.customers_column_since() },
                { value: 'spent', label: m.customers_column_spent() },
              ],
              onChange: (key) => setSort({ ...sort, key }),
              direction: sort.direction,
              onDirectionChange: (direction) => setSort({ ...sort, direction }),
            }}
            onRefresh={() => {}}
          />
        }
        notices={
          <>
            {state === 'unresolved' ? (
              <Alert tone="info" role="status">
                <p>{m.customers_list_unresolved()}</p>
              </Alert>
            ) : null}
            <CustomerAccessNotices
              organizationId={organizationId}
              sources={shown.sources}
            />
            <CollectionNotices
              offline={state === 'offline'}
              error={error}
              hasRows={!hidden}
              retry={() => {}}
              firstPage={() => {}}
              repair={state === 'repair' ? () => {} : undefined}
            />
          </>
        }
        loading={state === 'loading'}
        results={
          hidden ? undefined : (
            <CustomerResults
              list={shown}
              layout={state === 'rows' ? 'list' : 'table'}
              density="comfortable"
              grouping={grouping}
              caption="All customers. Sorted by: Customer since"
              link={link}
              empty={
                <CustomersEmpty
                  organizationId={organizationId}
                  list={shown}
                  filtered={state === 'unmatched'}
                  clear={() => {}}
                />
              }
              sort={sort}
              onSortChange={setSort}
              columnState={{
                columns: [
                  'name',
                  'orders',
                  'spent',
                  'created',
                  'state',
                  'tags',
                ].map((key) => ({ key })),
              }}
              onColumnStateChange={() => {}}
              properties={['orders', 'spent', 'created', 'state']}
              current={open}
              selection={{ selected, onChange: setSelected }}
              groupLabel={(key) => customerGroupLabel('state', undefined, key)}
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
              totalCount={shown.totalCount}
              page={1}
              pageSize={50}
              hasNext={false}
              onNext={() => {}}
              formatTotal={(count) =>
                m.customers_list_pagination_total({ count })
              }
              label={m.customers_list_pagination_label()}
            />
          ) : null
        }
        preview={
          state === 'preview'
            ? {
                open: !!openCustomer,
                title: openCustomer?.displayName,
                content: openCustomer ? (
                  <CustomerPreview
                    organizationId={organizationId}
                    customerId={openCustomer.id}
                    customer={openCustomer}
                    sourceLabel={sourceLabel}
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

function Content({ state }: { state: string }) {
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

  return <ListContent state={state as ListState} />;
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

export const Rows: Story = {
  args: { state: 'rows' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: /All customers/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: /Jonas Weber/ }),
    ).toBeVisible();
    // Attention stays visible whatever the chosen properties.
    await expect(canvas.getByText('No longer in Vienna store')).toBeVisible();
  },
};

export const Grouped: Story = {
  args: { state: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const enabled = await canvas.findByRole('button', {
      name: /^Has account/,
    });
    await expect(enabled).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText('Spent €9,640.00')).toBeVisible();
    await expect(canvas.getByText('Incomplete')).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Show more in Has account' }),
    ).toBeVisible();
    await userEvent.click(enabled);
    await expect(enabled).toHaveAttribute('aria-expanded', 'false');
  },
};

export const GroupedDark: Story = {
  args: { state: 'grouped' },
  globals: { theme: 'dark' },
};

export const OpenPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole('region', {
      name: 'Customer preview',
    });
    await expect(within(preview).getByText('150-0001 Shibuya')).toBeVisible();
    await expect(
      within(preview).getByRole('button', { name: 'Filter by Has account' }),
    ).toBeVisible();
    await expect(
      within(preview).getByRole('button', { name: 'Filter by VIP' }),
    ).toBeVisible();
  },
};

export const PreviewNarrow: Story = {
  args: { state: 'preview' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const NoMatches: Story = {
  args: { state: 'unmatched' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'No customers match' }),
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

export const StalePage: Story = {
  args: { state: 'page' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/This page link no longer matches/),
    ).toBeVisible();
  },
};

export const AccessLost: Story = { args: { state: 'access' } };

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
