import type { OrderDetail, OrderList, OrderListItem } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { StoryShell } from '../identity/storybook-shell';
import { returnItem } from '../returns/returns-fixtures';
import type { OrdersError, OrdersSearch } from './data';
import { OrderDetailView, type OrderError } from './detail';
import { OrdersView } from './page';

const organizationId = '33333333-3333-4333-8333-333333333333';
const shop = '44444444-4444-4444-8444-444444444444';
const erp = '55555555-5555-4555-8555-555555555555';

const sources: OrderListItem['sources'] = [
  {
    connectionId: shop,
    label: 'Tokyo store',
    system: 'shopify',
    connectionStatus: 'active',
    externalId: 'gid://shopify/Order/1001',
    selected: false,
    deleted: false,
    observedAt: '2026-09-28T08:00:00.000Z',
    sourceUpdatedAt: '2026-09-28T07:55:00.000Z',
  },
  {
    connectionId: erp,
    label: 'JTL-Wawi',
    system: 'jtl',
    connectionStatus: 'active',
    externalId: '10',
    selected: true,
    deleted: false,
    observedAt: '2026-09-28T09:00:00.000Z',
    sourceUpdatedAt: '2026-09-28T08:58:00.000Z',
  },
];

const order = (
  index: number,
  overrides: Partial<OrderListItem> = {},
): OrderListItem => ({
  id: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
  displayNumber: `#${1000 + index}`,
  placedAt: `2026-09-${String(10 + index).padStart(2, '0')}T08:00:00.000Z`,
  total: { amount: `${24 * (index + 1)}.00`, currency: 'EUR' },
  status: 'open',
  paymentStatus: 'paid',
  fulfillment: 'unfulfilled',
  lineCount: 1,
  open: true,
  overdue: false,
  dueAt: null,
  issueIds: [],
  differs: false,
  sources: [sources[0]!],
  observedAt: '2026-09-28T08:00:00.000Z',
  sourceUpdatedAt: '2026-09-28T07:55:00.000Z',
  ...overrides,
});

const list: OrderList = {
  items: [
    order(1, {
      displayNumber: 'SO-10',
      paymentStatus: 'pending',
      fulfillment: 'partial',
      issueIds: ['77777777-7777-4777-8777-777777777777'],
      differs: true,
      sources,
    }),
    order(2, {
      overdue: true,
      dueAt: '2026-09-20T00:00:00.000Z',
    }),
    order(3, {
      status: 'completed',
      fulfillment: 'fulfilled',
      open: false,
      total: null,
      placedAt: null,
    }),
  ],
  totalCount: 1284,
  nextCursor: 'next',
  asOf: '2026-09-28T09:00:00.000Z',
};

const line = (
  overrides: Partial<OrderDetail['sources'][number]['lines'][number]> = {},
) => ({
  id: '88888888-8888-4888-8888-888888888888',
  skuId: '99999999-9999-4999-8999-999999999999',
  skuCode: 'TOTE-RED',
  title: 'Canvas tote',
  quantity: '2',
  currentQuantity: '2',
  cancelledQuantity: '0',
  unit: 'each',
  fulfilledQuantity: '1',
  remainingQuantity: '1',
  ...overrides,
});

const detail: OrderDetail = {
  order: list.items[0]!,
  sources: [
    {
      ...sources[0]!,
      appId: 'shopify',
      mappingMethod: 'Linked by a person as the same record in another source',
      displayNumber: '#1001',
      status: 'open',
      paymentStatus: 'paid',
      placedAt: '2026-09-11T08:00:00.000Z',
      total: { amount: '48.00', currency: 'EUR' },
      dueAt: null,
      fulfillment: 'partial',
      open: null,
      lines: [
        line({
          currentQuantity: null,
          cancelledQuantity: null,
          remainingQuantity: null,
        }),
      ],
    },
    {
      ...sources[1]!,
      appId: 'jtl',
      mappingMethod: 'Linked by a person as the same record in another source',
      displayNumber: 'SO-10',
      status: 'open',
      paymentStatus: 'pending',
      placedAt: '2026-09-11T08:05:00.000Z',
      total: { amount: '48', currency: 'EUR' },
      dueAt: '2026-09-30T00:00:00.000Z',
      fulfillment: 'unfulfilled',
      open: true,
      lines: [line({ fulfilledQuantity: '0', remainingQuantity: '2' })],
    },
  ],
  differences: [
    {
      field: 'paymentStatus',
      values: [
        { connectionId: shop, value: 'paid' },
        { connectionId: erp, value: 'pending' },
      ],
    },
  ],
  fulfillments: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connectionId: shop,
      externalId: 'gid://shopify/Fulfillment/51',
      status: 'shipped',
      lastProgressAt: '2026-09-27T10:00:00.000Z',
      failureCode: null,
      deleted: false,
      observedAt: '2026-09-27T10:05:00.000Z',
      sourceUpdatedAt: '2026-09-27T10:00:00.000Z',
      lines: [
        {
          orderLineId: '88888888-8888-4888-8888-888888888888',
          quantity: '1',
          remainingQuantity: null,
          unit: 'each',
        },
      ],
    },
  ],
  returns: [
    returnItem({
      order: { id: list.items[0]!.id, displayNumber: '#1001' },
      connectionId: shop,
    }),
  ],
  issues: [
    {
      id: '77777777-7777-4777-8777-777777777777',
      class: 'stuck_fulfillment',
      state: 'escalated',
      severity: 'high',
      relationship: 'fulfillment',
      needsYou: true,
      lastDetectedAt: '2026-09-28T06:00:00.000Z',
    },
  ],
  workflows: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      definitionId: 'shipping-method',
      name: 'Correct shipping method',
      version: '1',
      createdAt: '2026-09-28T06:30:00.000Z',
      state: 'awaiting_approval',
      relationship: 'order',
    },
  ],
  history: {
    entries: [
      {
        snapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        entityKind: 'order',
        entityId: list.items[0]!.id,
        connectionId: erp,
        status: 'open',
        paymentStatus: 'pending',
        deleted: false,
        current: true,
        observedAt: '2026-09-28T09:00:00.000Z',
        sourceUpdatedAt: '2026-09-28T08:58:00.000Z',
      },
      {
        snapshotId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        entityKind: 'fulfillment',
        entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        connectionId: shop,
        status: 'shipped',
        paymentStatus: null,
        deleted: false,
        current: true,
        observedAt: '2026-09-27T10:05:00.000Z',
        sourceUpdatedAt: '2026-09-27T10:00:00.000Z',
      },
    ],
    truncated: false,
  },
  activity: {
    entries: [
      {
        id: 'event-1',
        recordedAt: '2026-09-28T06:00:00.000Z',
        action: 'exception.detected',
        type: 'issue',
        outcome: 'recorded',
        actor: {
          kind: 'luma',
          id: null,
          name: null,
          email: null,
          workflow: null,
        },
        exceptionId: '77777777-7777-4777-8777-777777777777',
        summary: null,
      },
    ],
    truncated: false,
  },
  asOf: '2026-09-28T09:00:00.000Z',
};

type ListState =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'unmatched'
  | 'unavailable'
  | 'page'
  | 'access'
  | 'offline';

function ListPreview({ state = 'ready' }: { state?: ListState }) {
  const [search, change] = useState<OrdersSearch>(
    state === 'unmatched' ? { q: 'NOPE', view: 'overdue' } : {},
  );
  const error: OrdersError | undefined =
    state === 'unavailable' || state === 'access'
      ? { kind: state }
      : state === 'page'
        ? {
            kind: 'page',
            message:
              'This page link no longer matches the order filters. Start from the first page.',
          }
        : undefined;

  return (
    <OrdersView
      organizationId={organizationId}
      search={search}
      change={change}
      refresh={() => {}}
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={error}
      sources={[
        { id: shop, label: 'Tokyo store' },
        { id: erp, label: 'JTL-Wawi' },
      ]}
      next={() => change({ ...search, cursor: 'next', page: 2 })}
      list={
        ['loading', 'access', 'page'].includes(state)
          ? undefined
          : ['empty', 'unmatched'].includes(state)
            ? { ...list, items: [], totalCount: 0, nextCursor: null }
            : list
      }
    />
  );
}

function DetailPreview({
  state = 'ready',
}: {
  state?: 'ready' | 'loading' | OrderError | 'offline' | undefined;
}) {
  return (
    <OrderDetailView
      organizationId={organizationId}
      search={{ view: 'needs_you' }}
      refresh={() => {}}
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={
        state === 'missing' || state === 'access' || state === 'unavailable'
          ? state
          : undefined
      }
      detail={state === 'ready' || state === 'offline' ? detail : undefined}
      sourceContext={(source) =>
        source.appId === 'shopify' ? (
          <p className="order-note">
            Live Shopify payments, customer, holds, returns, refunds and events
            appear here.
          </p>
        ) : null
      }
    />
  );
}

function Routed({ children }: { children: () => ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            {children()}
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

function Preview({
  page = 'list',
  state = 'ready',
}: {
  page?: 'list' | 'detail';
  state?: string;
}) {
  return (
    <Routed>
      {() =>
        page === 'list' ? (
          <ListPreview state={state as ListState} />
        ) : (
          <StoryShell page="orders">
            <DetailPreview
              state={state as Parameters<typeof DetailPreview>[0]['state']}
            />
          </StoryShell>
        )
      }
    </Routed>
  );
}

const meta = {
  title: 'Orders/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Browse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'SO-10' }),
    ).toBeVisible();
    await expect(
      within(canvas.getByRole('table')).getByText('Needs you'),
    ).toBeVisible();
    await expect(canvas.getByText('1–3 of 1,284 orders')).toBeVisible();
    const placed = canvas.getByRole('columnheader', { name: /Placed/ });
    await userEvent.click(within(placed).getByRole('button'));
    await expect(placed).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(within(placed).getByRole('button'));
    await expect(placed).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(canvas.getByRole('tab', { name: 'Overdue' }));
    await expect(canvas.getByRole('tab', { name: 'Overdue' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      canvas.getByRole('tab', { name: 'All orders' }),
    ).toHaveAttribute('aria-selected', 'false');
  },
};

export const Filter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Add Status filter' }),
    );
    await userEvent.click(
      within(await page.findByRole('dialog')).getByRole('button', {
        name: 'Open',
      }),
    );
    await expect(
      await canvas.findByRole('button', { name: 'Edit Status filter: Open' }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Placed filter' }),
    );
    await userEvent.click(
      within(await page.findByRole('dialog')).getByRole('button', {
        name: 'Last 7 days',
      }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Placed filter: Last 7 days',
      }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Remove Status filter: Open' }),
    );
    await expect(
      canvas.queryByRole('button', { name: 'Edit Status filter: Open' }),
    ).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    await expect(
      canvas.queryByRole('button', { name: /^Edit Placed filter/ }),
    ).toBeNull();
  },
};

export const Loading: Story = { args: { state: 'loading' } };

export const NoOrders: Story = { args: { state: 'empty' } };

export const NoMatches: Story = { args: { state: 'unmatched' } };

export const Unavailable: Story = { args: { state: 'unavailable' } };

export const StalePage: Story = {
  args: { state: 'page' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/This page link no longer matches/),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Go to first page' }),
    ).toBeVisible();
  },
};

export const AccessLost: Story = { args: { state: 'access' } };

export const Offline: Story = { args: { state: 'offline' } };

export const ListNarrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const OrderRecord: Story = {
  args: { page: 'detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'SO-10', level: 1 }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'Payment differs between sources: “Payment pending” in JTL-Wawi and “Paid” in Tokyo store.',
      ),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Tokyo store' }));
    const unknownQuantities = canvas.getAllByText('Not reported');
    await expect(unknownQuantities).toHaveLength(2);
    for (const quantity of unknownQuantities)
      await expect(quantity).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: /Review issue/ }),
    ).toBeVisible();
    // The breadcrumb names the order once; Luma's internal ID stays out of the page.
    await expect(
      canvas.getByText('SO-10', { selector: '[aria-current]' }),
    ).toBeVisible();
    await expect(canvas.queryByText(/66666666-/)).toBeNull();
  },
};

export const RecordLoading: Story = {
  args: { page: 'detail', state: 'loading' },
};

export const RecordMissing: Story = {
  args: { page: 'detail', state: 'missing' },
};

export const RecordOffline: Story = {
  args: { page: 'detail', state: 'offline' },
};

export const RecordNarrow: Story = {
  args: { page: 'detail' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
