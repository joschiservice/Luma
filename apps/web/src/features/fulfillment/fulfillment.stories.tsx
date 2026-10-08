import type {
  FulfillmentDetail,
  FulfillmentItem,
  FulfillmentList,
} from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
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
import type { FulfillmentSearch } from './data';
import { FulfillmentDetailView } from './detail';
import { FulfillmentView } from './page';

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
        actorKind: 'system',
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
  const [search, change] = useState<FulfillmentSearch>({});
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

  return (
    <FulfillmentView
      organizationId={org}
      search={search}
      change={change}
      refresh={() => {}}
      next={() => {}}
      list={
        state === 'loading' || state === 'error'
          ? undefined
          : state === 'calm'
            ? {
                ...list,
                items: [],
                counts: { ...list.counts, attention: 0, held: 0, delayed: 0 },
                nextCursor: null,
              }
            : list
      }
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={state === 'error' ? 'Service unavailable.' : undefined}
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
    await expect(canvas.getByText('Past fulfill-by date')).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: /On hold/ }));
    await expect(canvas.getByRole('tab', { name: /On hold/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const Filter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Add Location filter' }),
    );
    await userEvent.click(
      await page.findByRole('button', { name: 'Tokyo warehouse · 14 open' }),
    );
    await expect(
      await canvas.findByRole('button', {
        name: 'Edit Location filter: Tokyo warehouse · 14 open',
      }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Add Type filter' }),
    );
    await userEvent.click(
      await page.findByRole('button', { name: 'Shipments' }),
    );
    await userEvent.click(
      await canvas.findByRole('button', {
        name: 'Remove Type filter: Shipments',
      }),
    );
    await expect(
      canvas.queryByRole('button', { name: /^(Edit|Remove) Type filter/ }),
    ).toBeNull();
    await expect(
      canvas.getByRole('button', { name: /^Edit Location filter/ }),
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

export const NotFound: Story = { args: { state: 'not-found' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
