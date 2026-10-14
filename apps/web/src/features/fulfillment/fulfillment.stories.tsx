import type {
  FulfillmentDetail,
  FulfillmentItem,
  FulfillmentList,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
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
import { fulfillmentGroupLabel } from './collection';
import { fulfillmentOptions } from './data';
import { FulfillmentDetailView } from './detail';
import { FulfillmentEmpty, FulfillmentTabs, FulfillmentView } from './page';
import { orderLabel } from './presentation';
import { FulfillmentPreview } from './preview';
import { FulfillmentResults } from './results';

const org = '33333333-3333-4333-8333-333333333333';
const store = '66666666-6666-4666-8666-666666666666';
const erp = '55555555-5555-4555-8555-555555555555';
const tokyo = '77777777-7777-4777-8777-777777777777';
const asOf = '2026-09-30T09:00:00.000Z';

const item = (
  id: number,
  patch: Partial<FulfillmentItem>,
): FulfillmentItem => ({
  id: `11111111-1111-4111-8111-${String(id).padStart(12, '0')}`,
  connectionId: store,
  externalId: `gid://shopify/FulfillmentOrder/${id}`,
  kind: 'fulfillment_order',
  status: 'pending',
  deleted: false,
  open: true,
  signals: [],
  holds: [],
  location: { id: tokyo, name: 'Tokyo warehouse' },
  method: { type: 'shipping', name: 'Express' },
  fulfillAt: null,
  fulfillBy: '2026-10-01T09:00:00.000Z',
  estimatedDeliveryAt: null,
  lastProgressAt: '2026-09-30T05:00:00.000Z',
  progressAt: '2026-09-30T05:00:00.000Z',
  delivery: null,
  failureCode: null,
  tracking: [],
  units: '2',
  unit: 'each',
  order: {
    id: `22222222-2222-4222-8222-${String(id).padStart(12, '0')}`,
    number: `#${id}`,
    status: 'open',
    placedAt: '2026-09-27T09:00:00.000Z',
  },
  observedAt: '2026-09-30T08:55:00.000Z',
  sourceUpdatedAt: '2026-09-30T05:00:00.000Z',
  ...patch,
});

const held = item(1042, {
  signals: ['held', 'overdue'],
  holds: ['incorrect_address'],
  fulfillBy: '2026-09-29T18:00:00.000Z',
  lastProgressAt: '2026-09-29T11:20:00.000Z',
  progressAt: '2026-09-29T11:20:00.000Z',
});

const items: FulfillmentItem[] = [
  item(1017, {
    status: 'processing',
    signals: ['stalled'],
    fulfillBy: null,
    lastProgressAt: '2026-09-26T16:00:00.000Z',
    progressAt: '2026-09-26T16:00:00.000Z',
  }),
  held,
  item(1055, {
    externalId: 'gid://shopify/Fulfillment/1055',
    kind: 'shipment',
    status: 'shipped',
    open: false,
    signals: ['delivery_issue'],
    delivery: 'attempted_delivery',
    fulfillBy: null,
    estimatedDeliveryAt: '2026-09-30T18:00:00.000Z',
    tracking: [
      {
        carrier: 'Yamato',
        number: '4521-8876-0012',
        url: 'https://tracking.example.test/4521-8876-0012',
      },
    ],
    lastProgressAt: '2026-09-30T07:10:00.000Z',
    progressAt: '2026-09-30T07:10:00.000Z',
  }),
  item(310, {
    connectionId: erp,
    externalId: '31',
    kind: 'shipment',
    status: 'failed',
    signals: ['failed'],
    failureCode: 'carrier_rejected',
    open: false,
    holds: null,
    location: null,
    method: null,
    fulfillBy: null,
    lastProgressAt: '2026-09-30T08:00:00.000Z',
    progressAt: '2026-09-30T08:00:00.000Z',
  }),
];

const list: FulfillmentList = {
  items,
  sources: [
    {
      connectionId: erp,
      label: 'JTL-Wawi',
      system: 'jtl-onprem',
      status: 'active',
      appId: 'jtl',
    },
    {
      connectionId: store,
      label: 'Shopify · EU store',
      system: 'shopify',
      status: 'active',
      appId: 'shopify',
    },
  ],
  locations: [{ id: tokyo, name: 'Tokyo warehouse', open: 14 }],
  counts: {
    attention: 4,
    held: 1,
    delayed: 2,
    open: 14,
    in_transit: 6,
    all: 131,
  },
  nextCursor: 'next',
  stalledAfterHours: 48,
  asOf,
};

const detail: FulfillmentDetail = {
  item: held,
  source: list.sources[1]!,
  lines: [
    {
      orderLineId: '44444444-4444-4444-8444-444444444444',
      quantity: '2',
      unit: 'each',
      skuId: '88888888-8888-4888-8888-888888888888',
      skuCode: 'LINEN-SHIRT-M',
      title: 'Linen shirt · M',
      ordered: '2',
    },
  ],
  order: {
    id: held.order.id,
    number: '#1042',
    status: 'open',
    paymentStatus: 'paid',
    placedAt: '2026-09-27T09:00:00.000Z',
    externalId: 'gid://shopify/Order/1042',
    fulfillment: 'unfulfilled',
  },
  related: [],
  timeline: {
    entries: [
      {
        snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        current: true,
        deleted: false,
        observedAt: '2026-09-30T08:55:00.000Z',
        sourceUpdatedAt: '2026-09-29T11:20:00.000Z',
        status: 'pending',
        holds: ['incorrect_address'],
        delivery: null,
        lastProgressAt: '2026-09-29T11:20:00.000Z',
        locationName: 'Tokyo warehouse',
        fulfillBy: '2026-09-29T18:00:00.000Z',
      },
      {
        snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        current: false,
        deleted: false,
        observedAt: '2026-09-29T11:25:00.000Z',
        sourceUpdatedAt: '2026-09-29T11:20:00.000Z',
        status: 'pending',
        holds: ['incorrect_address'],
        delivery: null,
        lastProgressAt: '2026-09-29T11:20:00.000Z',
        locationName: 'Tokyo warehouse',
        fulfillBy: '2026-09-29T18:00:00.000Z',
      },
      {
        snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        current: false,
        deleted: false,
        observedAt: '2026-09-27T09:05:00.000Z',
        sourceUpdatedAt: '2026-09-27T09:00:00.000Z',
        status: 'pending',
        holds: [],
        delivery: null,
        lastProgressAt: '2026-09-27T09:00:00.000Z',
        locationName: 'Tokyo warehouse',
        fulfillBy: '2026-09-29T18:00:00.000Z',
      },
    ],
    truncated: false,
  },
  issues: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      class: 'stuck_fulfillment',
      state: 'open',
      severity: 'medium',
      relationship: 'fulfillment',
      needsYou: true,
      lastDetectedAt: '2026-09-30T08:00:00.000Z',
      occurrences: 1,
    },
  ],
  workflows: [
    {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      definitionId: 'shipping-method-correction',
      name: 'Correct an order shipping method',
      version: '0.1.0',
      createdAt: '2026-09-29T12:00:00.000Z',
      state: 'verified',
      relationship: 'issue',
      purpose: 'method_correction',
      progressObservedAt: null,
    },
  ],
  activity: {
    entries: [
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        recordedAt: '2026-09-29T12:04:00.000Z',
        action: 'action.execution.verified',
        type: 'execution',
        outcome: 'succeeded',
        actor: {
          kind: 'member',
          id: '99999999-9999-4999-8999-999999999999',
          name: 'Mia Keller',
          email: 'mia@example.test',
          workflow: { id: 'shipping-method', name: 'Correct shipping methods' },
        },
        exceptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        summary: 'Shipping method changed to Express',
      },
    ],
    truncated: false,
  },
  stalledAfterHours: 48,
  asOf,
};

const shipmentDetail: FulfillmentDetail = {
  ...detail,
  item: items[2]!,
  order: { ...detail.order, number: '#1055', fulfillment: 'fulfilled' },
  related: [
    item(1055, {
      status: 'completed',
      open: false,
      fulfillBy: null,
      signals: [],
    }),
  ],
  timeline: {
    entries: [
      {
        ...detail.timeline.entries[0]!,
        status: 'shipped',
        holds: null,
        delivery: 'attempted_delivery',
        fulfillBy: null,
      },
      {
        ...detail.timeline.entries[2]!,
        status: 'shipped',
        holds: null,
        delivery: 'in_transit',
        fulfillBy: null,
      },
    ],
    truncated: false,
  },
  issues: [],
  workflows: [],
  activity: { entries: [], truncated: false },
};

// Stands in for the Shopify recovery panel mounted through the app's fulfillment slot.
const actions = (
  <div className="fulfillment-cell">
    <strong>Release hold · Incorrect address</strong>
    <small>
      Needs approval from someone else who can approve changes. Luma verifies
      with a fresh read.
    </small>
    <Button variant="outline">Preview release</Button>
  </div>
);

function Content({ state }: { state: string }) {
  if (state === 'shipping-handoff' || state === 'stale-tracking') {
    const carrier = state === 'stale-tracking';

    return (
      <FulfillmentDetailView
        organizationId={org}
        refresh={() => {}}
        detail={{
          ...shipmentDetail,
          source: {
            ...shipmentDetail.source,
            label: 'Starshipit',
            system: 'starshipit',
            appId: 'starshipit',
          },
          order: {
            ...shipmentDetail.order,
            paymentStatus: 'unknown',
            fulfillment: carrier ? 'fulfilled' : 'unknown',
          },
          related: [],
          item: {
            ...shipmentDetail.item,
            externalId: '1042:parcel:STAR1042',
            status: carrier ? 'shipped' : 'pending',
            lastProgressAt: carrier ? '2026-09-27T05:00:00.000Z' : null,
            open: !carrier,
            delivery: carrier ? 'in_transit' : 'label_created',
            signals: [],
            shipping: {
              stage: carrier ? 'carrier' : 'unknown',
              sourceUrl: 'https://app.starshipit.com/',
              trackingUpdatedAt: carrier ? '2026-09-27T05:00:00.000Z' : null,
            },
          },
          timeline: {
            entries: [
              {
                ...shipmentDetail.timeline.entries[0]!,
                status: carrier ? 'shipped' : 'pending',
                delivery: carrier ? 'in_transit' : 'label_created',
                lastProgressAt: carrier ? '2026-09-27T05:00:00.000Z' : null,
                shipping: {
                  stage: carrier ? 'carrier' : 'unknown',
                  sourceUrl: 'https://app.starshipit.com/',
                  trackingUpdatedAt: carrier
                    ? '2026-09-27T05:00:00.000Z'
                    : null,
                },
              },
            ],
            truncated: false,
          },
        }}
      />
    );
  }
  if (state === 'detail' || state === 'shipment')
    return (
      <FulfillmentDetailView
        organizationId={org}
        detail={state === 'shipment' ? shipmentDetail : detail}
        refresh={() => {}}
        actions={state === 'detail' ? actions : null}
      />
    );
  if (state === 'not-found')
    return (
      <FulfillmentDetailView
        organizationId={org}
        error="missing"
        refresh={() => {}}
      />
    );

  return <ListPreview state={state} />;
}

const groupedList: FulfillmentList = {
  ...list,
  nextCursor: null,
  groups: [
    {
      key: 'merchant',
      count: 9,
      complete: true,
      itemIds: [items[0]!.id, held.id],
      nextCursor: 'group-next',
      sums: [],
    },
    {
      key: 'carrier',
      count: 1,
      complete: false,
      itemIds: [items[2]!.id],
      nextCursor: null,
      sums: [],
    },
    {
      key: null,
      count: 1,
      complete: true,
      itemIds: [items[3]!.id],
      nextCursor: null,
      sums: [],
    },
  ],
};

/** The list page as the route renders it, with fixed rows and local view state. */
function ListPreview({ state }: { state: string }) {
  const [segment, setSegment] = useState('attention');
  const [sort, setSort] = useState<DataTableSort>({
    key: 'waiting',
    direction: 'asc',
  });
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<string | undefined>(
    state === 'preview' ? held.id : undefined,
  );
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(fulfillmentOptions(org, held.id).queryKey, {
      ...detail,
      stalledAfterHours: 48,
      asOf,
    });

    return queryClient;
  });
  const layout =
    state === 'list' ? 'list' : state === 'board' ? 'board' : 'table';
  const grouping =
    state === 'grouped' || state === 'board'
      ? { field: 'stage', showEmpty: false }
      : null;
  const shown =
    state === 'calm'
      ? {
          ...list,
          items: [],
          counts: { ...list.counts, attention: 0, held: 0, delayed: 0 },
          nextCursor: null,
        }
      : state === 'unmatched'
        ? { ...list, items: [], nextCursor: null }
        : grouping
          ? groupedList
          : list;
  const error: CollectionError | undefined =
    state === 'error'
      ? { kind: 'unavailable' }
      : state === 'repair'
        ? { kind: 'invalid', message: m.collections_needs_repair() }
        : undefined;
  const hidden = ['loading', 'error', 'repair'].includes(state);
  const link = (row: FulfillmentItem) => (
    <a
      href={`#fulfillment-${row.id}`}
      onClick={(event) => {
        if (state !== 'preview') return;
        event.preventDefault();
        setOpen(row.id);
      }}
    />
  );
  const openItem = shown.items.find((row) => row.id === open);

  return (
    <QueryClientProvider client={client}>
      <FulfillmentView
        toolbar={
          <CollectionToolbar
            views={
              <FulfillmentTabs
                value={segment}
                counts={hidden ? undefined : shown.counts}
                onChange={setSegment}
              />
            }
            search={{
              value: state === 'unmatched' ? 'NOPE' : undefined,
              onChange: () => {},
              label: m.fulfillment_list_search_label(),
              placeholder: m.fulfillment_list_search_placeholder(),
            }}
            sort={{
              value: sort.key,
              options: [
                { value: 'waiting', label: 'Last progress' },
                { value: 'fulfillBy', label: 'Fulfill by' },
              ],
              onChange: (key) => setSort({ ...sort, key }),
              direction: sort.direction,
              onDirectionChange: (direction) => setSort({ ...sort, direction }),
            }}
            onRefresh={() => {}}
          />
        }
        note={m.fulfillment_list_note({ hours: 48 })}
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
            <FulfillmentResults
              list={shown}
              layout={layout}
              density="comfortable"
              grouping={grouping}
              caption="Needs attention. Sorted by: Last progress"
              link={link}
              empty={
                <FulfillmentEmpty
                  organizationId={org}
                  segment={segment}
                  filtered={state === 'unmatched'}
                  clear={() => {}}
                />
              }
              sort={sort}
              onSortChange={setSort}
              columnState={{
                columns: [
                  'order',
                  'status',
                  'signals',
                  'location',
                  'progress',
                ].map((key) => ({ key })),
              }}
              onColumnStateChange={() => {}}
              properties={['status', 'signals', 'location', 'progress']}
              current={open}
              selection={{ selected, onChange: setSelected }}
              groupLabel={(key) =>
                fulfillmentGroupLabel('stage', undefined, key)
              }
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
              totalCount={shown.counts.attention}
              page={1}
              pageSize={50}
              hasNext={!!shown.nextCursor}
              onNext={() => {}}
              formatTotal={(count) =>
                m.fulfillment_list_pagination_total({ count })
              }
              label={m.fulfillment_list_pagination_label()}
            />
          ) : null
        }
        preview={
          state === 'preview'
            ? {
                open: !!openItem,
                title: openItem ? orderLabel(openItem) : undefined,
                content: openItem ? (
                  <FulfillmentPreview
                    organizationId={org}
                    fulfillmentId={openItem.id}
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
  title: 'Fulfillment/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Attention: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: '#1042' }),
    ).toBeVisible();
    await expect(canvas.getByText('Held: Incorrect address.')).toBeVisible();
    await expect(canvas.getByText('1–4 of 4 fulfillments')).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: /On hold/ }));
    await expect(canvas.getByRole('tab', { name: /On hold/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const List: Story = {
  args: { state: 'list' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('list', { name: /Needs attention/ }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: /#1042/ })).toBeVisible();
  },
};

export const Grouped: Story = {
  args: { state: 'grouped' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const merchant = await canvas.findByRole('button', {
      name: /^Waiting at merchant/,
    });
    await expect(merchant).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText('Incomplete')).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Show more in Waiting at merchant' }),
    ).toBeVisible();
  },
};

export const BoardByStage: Story = {
  args: { state: 'board' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('region', { name: /With carrier/ }),
    ).toBeVisible();
    // Sources own the shipping stage, so cards can't be moved.
    await expect(canvas.queryByRole('button', { name: 'Move to…' })).toBeNull();
  },
};

export const BoardDark: Story = {
  args: { state: 'board' },
  globals: { theme: 'dark' },
};

export const OpenPreview: Story = {
  args: { state: 'preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole('region', {
      name: 'Fulfillment preview',
    });
    await expect(
      await within(preview).findByText('Linen shirt · M'),
    ).toBeVisible();
    await expect(
      within(preview).getByRole('button', {
        name: 'Filter by Waiting to start',
      }),
    ).toBeVisible();
  },
};

export const NoMatches: Story = { args: { state: 'unmatched' } };

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

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const HeldDetail: Story = {
  args: { state: 'detail' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Resolve the hold reason, then release the hold',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        'Changes the shipping method. It doesn’t ship the order.',
      ),
    ).toBeVisible();
    await expect(canvas.getByText('No progress seen since')).toBeVisible();
    // The last change appears in the progress evidence and in the timeline.
    await expect(
      canvas.getAllByText('Hold added: Incorrect address'),
    ).toHaveLength(2);
  },
};

export const HeldDetailDark: Story = {
  args: { state: 'detail' },
  globals: { theme: 'dark' },
};

export const HeldDetailNarrow: Story = {
  args: { state: 'detail' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const ShipmentDetail: Story = {
  args: { state: 'shipment' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', {
        name: 'Check the shipment with Yamato',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: /Open carrier tracking/ }),
    ).toHaveAttribute('href', 'https://tracking.example.test/4521-8876-0012');
  },
};

export const NothingStuck: Story = { args: { state: 'calm' } };

export const ShippingHandoff: Story = {
  args: { state: 'shipping-handoff' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Handoff not confirmed' }),
    ).toBeVisible();
    await expect(
      canvas.getAllByText(
        'A label or booking does not confirm that the warehouse or carrier has received the shipment.',
      ),
    ).toHaveLength(2);
  },
};

export const ShippingHandoffDark: Story = {
  args: { state: 'shipping-handoff' },
  globals: { theme: 'dark' },
};

export const ShippingHandoffNarrow: Story = {
  args: { state: 'shipping-handoff' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const StaleTracking: Story = { args: { state: 'stale-tracking' } };

export const NotFound: Story = { args: { state: 'not-found' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
