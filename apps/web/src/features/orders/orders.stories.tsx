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

import { StoryShell } from '../../shell/storybook-shell';
import appStyles from '../../styles.css?inline';
import { returnItem } from '../returns/returns-fixtures';
import type { OrdersError, OrdersSearch } from './data';
import { OrderDetailView, type OrderError } from './detail';
import { OrderJourney } from './journey';
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
  comparisonState: 'matching' as const,
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
      comparisonState: 'confirmed',
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
  comparisonKey: '99999999-9999-4999-8999-999999999999',
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

const paid = (shop: string, presentment: string) => ({
  shop: { amount: shop, currency: 'EUR' },
  presentment: { amount: presentment, currency: 'CHF' },
});

const same = (shop: string, presentment: string) => ({
  original: paid(shop, presentment),
  current: paid(shop, presentment),
});

const detail: OrderDetail = {
  authority: {
    revision: 0,
    groups: [
      'order_lines',
      'order_lifecycle',
      'order_fulfillment',
      'order_tracking',
    ].map((group) => ({
      group: group as
        | 'order_lines'
        | 'order_lifecycle'
        | 'order_fulfillment'
        | 'order_tracking',
      state: 'resolved',
      basis: 'default',
      connectionId:
        group === 'order_lines' || group === 'order_lifecycle' ? shop : erp,
      overrideConnectionId: null,
      candidateIds: [],
      eligibleIds: [shop, erp],
    })),
    lines: null,
    lifecycle: null,
    fulfillments: [],
    tracking: [],
  },
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
      currencies: { shop: 'EUR', presentment: 'CHF' },
      amounts: {
        subtotal: same('48.00', '46.40'),
        shipping: same('4.90', '4.70'),
        discounts: { original: paid('5.33', '5.15'), current: null },
        tax: same('7.66', '7.41'),
        duties: { original: null, current: null },
        total: same('52.90', '51.10'),
      },
      taxesIncluded: true,
      dutiesIncluded: false,
      taxLines: [{ title: 'VAT', rate: '0.19', amount: paid('7.66', '7.41') }],
      shippingLines: [
        {
          id: 'gid://shopify/ShippingLine/71',
          title: 'Standard',
          code: 'STANDARD',
          source: 'shopify',
          carrier: null,
          removed: false,
          original: paid('4.90', '4.70'),
          discounted: paid('4.90', '4.70'),
          current: paid('4.90', '4.70'),
        },
        {
          id: 'gid://shopify/ShippingLine/72',
          title: 'Express',
          code: 'EXPRESS',
          source: 'shopify',
          carrier: 'DHL',
          removed: true,
          original: paid('9.90', '9.50'),
          discounted: paid('9.90', '9.50'),
          current: paid('0.00', '0.00'),
        },
      ],
      discounts: [
        {
          index: 0,
          kind: 'code',
          label: 'WELCOME10',
          target: 'line_item',
          allocation: 'across',
          value: { type: 'percentage', percentage: '10' },
        },
      ],
      tags: ['vip', 'gift'],
      attributes: {
        edited: true,
        requiresShipping: true,
        test: false,
        cancelReason: null,
        cancelledAt: null,
        closedAt: null,
        processedAt: '2026-09-11T08:00:05.000Z',
        channel: 'web',
        fulfillmentStatus: 'partially_fulfilled',
      },
      addresses: {
        state: 'shared',
        shipping: {
          line1: 'Hafenstraße 1',
          line2: null,
          city: 'Hamburg',
          region: null,
          postalCode: '20457',
          country: 'DE',
        },
        billing: null,
        observedAt: '2026-09-28T08:00:00.000Z',
      },
      lines: [
        line({
          currentQuantity: null,
          cancelledQuantity: null,
          remainingQuantity: null,
        }),
        line({
          id: '89898989-8989-4898-8989-898989898989',
          skuId: null,
          comparisonKey: null,
          skuCode: null,
          title: 'Gift wrapping',
          quantity: '1',
          currentQuantity: '1',
          cancelledQuantity: '0',
          remainingQuantity: '0',
          fulfilledQuantity: '0',
          catalog: 'no_product',
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
      addresses: { state: 'not_imported' },
      lines: [line({ fulfilledQuantity: '0', remainingQuantity: '2' })],
    },
  ],
  differences: [
    {
      field: 'paymentStatus',
      lineKey: null,
      authority: null,
      values: [
        { connectionId: shop, value: 'paid', evidence: [] },
        { connectionId: erp, value: 'pending', evidence: [] },
      ],
    },
    {
      field: 'fulfilledQuantity',
      lineKey: '99999999-9999-4999-8999-999999999999',
      authority: {
        group: 'order_fulfillment',
        state: 'resolved',
        basis: 'default',
        connectionId: erp,
        overrideConnectionId: null,
        candidateIds: [],
        eligibleIds: [shop, erp],
      },
      values: [
        { connectionId: shop, value: '1', evidence: [] },
        { connectionId: erp, value: '0', evidence: [] },
      ],
    },
    {
      field: 'location',
      lineKey: '99999999-9999-4999-8999-999999999999',
      authority: {
        group: 'order_fulfillment',
        state: 'resolved',
        basis: 'default',
        connectionId: erp,
        overrideConnectionId: null,
        candidateIds: [],
        eligibleIds: [shop, erp],
      },
      values: [
        {
          connectionId: shop,
          value: '[["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","1"]]',
          evidence: [],
        },
        {
          connectionId: erp,
          value: '[["cccccccc-cccc-4ccc-8ccc-cccccccccccc","2"]]',
          evidence: [],
        },
      ],
    },
  ],
  fulfillments: [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      connectionId: shop,
      externalId: 'gid://shopify/Fulfillment/51',
      status: 'shipped',
      location: {
        locationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'Tokyo warehouse',
      },
      tracking: null,
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
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      connectionId: erp,
      externalId: 'work-10',
      status: 'pending',
      kind: 'fulfillment_order',
      location: {
        locationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name: 'Osaka warehouse',
      },
      tracking: null,
      lastProgressAt: null,
      failureCode: null,
      deleted: false,
      observedAt: '2026-09-27T10:05:00.000Z',
      sourceUpdatedAt: '2026-09-27T10:00:00.000Z',
      lines: [
        {
          orderLineId: '88888888-8888-4888-8888-888888888888',
          quantity: '2',
          remainingQuantity: '2',
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
      occurrences: 1,
    },
  ],
  stockSync: [],
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
  hidden: [],
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
  state?:
    | 'ready'
    | 'loading'
    | OrderError
    | 'offline'
    | 'pending'
    | 'inconclusive'
    | 'syncing'
    | 'restricted'
    | undefined;
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
      detail={
        state === 'restricted'
          ? {
              ...detail,
              hidden: ['addresses'],
              sources: detail.sources.map((source) => {
                const restricted = { ...source };
                delete restricted.addresses;

                return restricted;
              }),
            }
          : state === 'pending' || state === 'inconclusive'
            ? {
                ...detail,
                order: {
                  ...detail.order,
                  differs: false,
                  comparisonState: state,
                },
              }
            : state === 'syncing'
              ? {
                  ...detail,
                  issues: [
                    ...detail.issues,
                    {
                      id: '78787878-7878-4878-8878-787878787878',
                      class: 'inventory_mismatch',
                      state: 'resolved',
                      severity: 'high',
                      relationship: 'sku',
                      needsYou: false,
                      lastDetectedAt: '2026-09-28T08:40:00.000Z',
                      occurrences: 54,
                    },
                  ],
                  stockSync: [
                    {
                      skuId: '99999999-9999-4999-8999-999999999999',
                      since: '2026-09-28T08:58:00.000Z',
                      until: '2026-09-28T09:13:00.000Z',
                    },
                  ],
                }
              : state === 'ready' || state === 'offline'
                ? detail
                : undefined
      }
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
    await userEvent.click(
      within(canvas.getByRole('group', { name: 'Show lines from' })).getByRole(
        'button',
        { name: 'Tokyo store' },
      ),
    );
    const lines = within(
      canvas.getByRole('table', {
        name: 'Lines reported by Tokyo store',
      }),
    );
    const unknownQuantities = lines.getAllByText('Not reported');
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

export const RecordPending: Story = {
  args: { page: 'detail', state: 'pending' },
};

export const RecordInconclusive: Story = {
  args: { page: 'detail', state: 'inconclusive' },
};

/** An ordered SKU whose stock gap is expected to close through provider sync. */
export const RecordStockSyncing: Story = {
  args: { page: 'detail', state: 'syncing' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = await canvas.findByRole('link', { name: /TOTE-RED/ });
    await expect(row).toHaveTextContent('Syncing');
    await expect(row).toHaveTextContent(
      /Raised as an issue if still open at .+\./,
    );
    // Resolved repeats of one stock issue are one row with their count.
    await expect(canvas.getByRole('link', { name: /54 times/ })).toBeVisible();
  },
};

const journeyDetail: OrderDetail = {
  ...detail,
  journey: {
    events: (
      [
        ['shipped', '2026-09-27T09:00:00.000Z'],
        ['delivered', '2026-09-27T10:00:00.000Z'],
      ] as const
    ).map(([stage, occurredAt]) => ({
      id: stage,
      orderId: detail.order.id,
      partId: detail.fulfillments[0]!.id,
      orderLineId: detail.fulfillments[0]!.lines[0]!.orderLineId,
      stage,
      provenance: 'provider_observation',
      connectionId: shop,
      actorId: null,
      occurredAt,
      observedAt: '2026-09-27T10:05:00.000Z',
      quantity: '1',
      unit: 'each',
      references: [
        {
          kind: 'shipment',
          id: detail.fulfillments[0]!.id,
          connectionId: shop,
        },
        {
          kind: 'snapshot',
          id: '99999999-9999-4999-8999-999999999999',
          connectionId: shop,
        },
      ],
    })),
    truncated: false,
    candidates: [],
    timings: [
      {
        partId: detail.fulfillments[0]!.id,
        orderLineId: detail.fulfillments[0]!.lines[0]!.orderLineId,
        connectionId: shop,
        from: 'shipped',
        to: 'delivered',
        durationMs: 3600000,
      },
    ],
    comparisons: [
      {
        from: 'shipped',
        to: 'delivered',
        count: 10,
        medianMs: 7200000,
        p90Ms: 14400000,
      },
    ],
  },
};

export const Journey: Story = {
  render: () => (
    <Routed>
      {() => (
        <div style={{ padding: 16 }}>
          <OrderJourney
            detail={journeyDetail}
            organizationId={organizationId}
            from="/"
          />
        </div>
      )}
    </Routed>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('1 h since Shipped.')).toBeVisible();
    await userEvent.click(canvas.getAllByText('Evidence references')[0]!);
    await expect(canvas.getAllByText(/99999999-9999/)[0]!).toBeVisible();
  },
};

export const JourneyDark: Story = { ...Journey, globals: { theme: 'dark' } };
/** Source-reported amounts, charges, discounts and addresses, in two currencies. */
export const RecordCharges: Story = {
  args: { page: 'detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = within(
      await canvas.findByRole('region', { name: 'Delivery and charges' }),
    );
    await userEvent.click(section.getByRole('button', { name: 'Tokyo store' }));
    await expect(section.getByText('EUR, charged in CHF')).toBeVisible();
    const amounts = within(
      section.getByRole('table', {
        name: 'Order amounts reported by Tokyo store',
      }),
    );
    await expect(amounts.getAllByText(/Charged/).length).toBeGreaterThan(0);
    // Unreported amounts, such as the current discount and duties, are not shown as zero.
    await expect(
      amounts.getAllByText('Not reported by Tokyo store'),
    ).toHaveLength(3);
    await expect(section.getByText('Removed')).toBeVisible();
    await expect(section.getByText('WELCOME10')).toBeVisible();
    await expect(section.getByText('Hafenstraße 1')).toBeVisible();
    // The custom line says the source has no product for it.
    await expect(
      canvas.getByText(/Custom item or deleted product/),
    ).toBeVisible();

    await userEvent.click(section.getByRole('button', { name: 'JTL-Wawi' }));
    await expect(
      section.getByText(
        'JTL-Wawi reports no delivery or charge details for this order.',
      ),
    ).toBeVisible();
    await expect(
      section.getByText('No addresses imported from JTL-Wawi yet.'),
    ).toBeVisible();
  },
};

/** Without permission to read customers, addresses are restricted rather than empty. */
export const RecordAddressesRestricted: Story = {
  args: { page: 'detail', state: 'restricted' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = within(
      await canvas.findByRole('region', { name: 'Delivery and charges' }),
    );
    await expect(
      section.getByText(/Addresses are customer data/),
    ).toBeVisible();
    await expect(section.queryByText('Hafenstraße 1')).toBeNull();
  },
};

export const RecordChargesNarrow: Story = {
  args: { page: 'detail' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
