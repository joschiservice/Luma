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
import type { ReturnsSearch } from './data';
import { ReturnDetailView } from './detail';
import { ReturnsView } from './page';
import { detail, list, returnItem, sources } from './returns-fixtures';

const org = '99999999-9999-4999-8999-999999999999';

const closed = {
  ...detail,
  item: returnItem({
    status: 'closed',
    stage: 'closed',
    group: 'done',
    received: '2',
    refundedUnits: '2',
    refund: {
      state: 'refunded',
      currency: 'EUR',
      refunded: '48',
      pending: null,
      failedAttempts: 1,
    },
  }),
  timeline: { ...detail.timeline, closedAt: '2026-09-30T07:00:00.000Z' },
  refunds: [
    detail.refunds[0]!,
    {
      ...detail.refunds[1]!,
      transactions: [
        {
          ...detail.refunds[1]!.transactions[0]!,
          status: 'success' as const,
          processedAt: '2026-09-29T10:02:00.000Z',
        },
      ],
    },
  ],
};

const requested = {
  ...detail,
  item: returnItem({
    status: 'requested',
    stage: 'requested',
    group: 'action',
    received: '0',
  }),
  timeline: {
    ...detail.timeline,
    approvedAt: null,
    receivedAt: null,
  },
  lines: detail.lines.map((line) => ({
    ...line,
    received: '0',
    restocked: '0',
    refunded: '0',
  })),
  refunds: [],
};

function Content({ state }: { state: string }) {
  const [search, change] = useState<ReturnsSearch>({});
  if (state === 'detail' || state === 'closed' || state === 'requested')
    return (
      <ReturnDetailView
        organizationId={org}
        detail={
          state === 'closed'
            ? closed
            : state === 'requested'
              ? requested
              : detail
        }
        refresh={() => {}}
      />
    );
  if (state === 'not-found')
    return (
      <ReturnDetailView
        organizationId={org}
        error="missing"
        refresh={() => {}}
      />
    );

  return (
    <ReturnsView
      organizationId={org}
      search={state === 'nothing-pending' ? { view: 'action' } : search}
      change={change}
      refresh={() => {}}
      next={() => {}}
      list={
        state === 'loading' || state === 'error'
          ? undefined
          : state === 'not-shared'
            ? {
                ...list,
                items: [],
                sources: sources.map((source) => ({
                  ...source,
                  access: 'not_requested' as const,
                  records: 0,
                })),
                counts: {
                  views: { action: 0, waiting: 0, done: 0, all: 0 },
                  stages: {},
                },
              }
            : state === 'nothing-pending'
              ? {
                  ...list,
                  items: [],
                  counts: {
                    views: { action: 0, waiting: 2, done: 7, all: 9 },
                    stages: { awaiting_items: 1, refund_pending: 1, closed: 7 },
                  },
                }
              : list
      }
      loading={state === 'loading'}
      offline={state === 'offline'}
      error={state === 'error' ? 'Returns could not be loaded.' : undefined}
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
  title: 'Returns/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Browse: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: '#1004-R1' }),
    ).toBeVisible();
    // A pending refund is never shown as money returned.
    await expect(canvas.getByText('€48.00 processing')).toBeVisible();
    await expect(canvas.queryByText(/€48.00 refunded/)).toBeNull();
    // JTL does not share returns, and the page says so.
    await expect(
      canvas.getByText(/JTL-Wawi does not share returns with Luma/),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole('button', { name: /^Refund failed/ }),
    );
    await expect(
      canvas.getByRole('button', { name: /^Refund failed/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    // The chosen stage is an applied filter chip that can be removed.
    await userEvent.click(
      canvas.getByRole('button', {
        name: 'Remove Stage filter: Refund failed',
      }),
    );
    await expect(
      canvas.getByRole('button', { name: /^Refund failed/ }),
    ).toHaveAttribute('aria-pressed', 'false');
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
      await canvas.findByRole('list', { name: 'Return progress' }),
    ).toBeVisible();
    await expect(canvas.getByText('Refunded to the customer')).toBeVisible();
    await expect(canvas.getByText('Nothing yet')).toBeVisible();
    await expect(
      canvas.getAllByRole('list', { name: 'Payment attempts' }),
    ).toHaveLength(2);
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

export const Requested: Story = {
  args: { state: 'requested' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Next step: to review' }),
    ).toBeVisible();
  },
};

export const Closed: Story = { args: { state: 'closed' } };

export const NotShared: Story = { args: { state: 'not-shared' } };

export const NothingPending: Story = {
  args: { state: 'nothing-pending' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Nothing needs action' }),
    ).toBeVisible();
  },
};

export const NotFound: Story = { args: { state: 'not-found' } };

export const Loading: Story = { args: { state: 'loading' } };

export const Error: Story = { args: { state: 'error' } };

export const Offline: Story = { args: { state: 'offline' } };
