import type { InsightChartResponse } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { ChartCard, type Selection } from './chart-card';
import type { InsightsError } from './data';
import insightStyles from './insights.css?inline';

const org = '33333333-3333-4333-8333-333333333333';
const asOf = '2026-10-01T09:00:00.000Z';

const days = Array.from({ length: 14 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 18 + index));
  const start = date.toISOString().slice(0, 10);
  const next = new Date(date.getTime() + 86_400_000).toISOString();
  const open = [0, 0, 0, 1, 0, 2, 1, 2, 3, 4, 6, 7, 9, 4][index]!;
  const completed = [0, 0, 0, 14, 12, 16, 9, 7, 15, 13, 11, 6, 2, 0][index]!;
  const cancelled = [0, 0, 0, 1, 0, 2, 0, 1, 0, 1, 2, 0, 1, 0][index]!;

  return {
    key: start,
    start,
    end: start,
    from: date.toISOString(),
    before: next,
    values: { open, completed, cancelled, unknown: 0 },
    total: open + completed + cancelled,
    coverage:
      index < 3
        ? ('not_imported' as const)
        : index === 13
          ? ('partial' as const)
          : ('complete' as const),
  };
});

const orders: InsightChartResponse = {
  chart: 'orders',
  kind: 'timeline',
  unit: 'order',
  series: ['open', 'completed', 'cancelled', 'unknown'],
  points: days,
  total: days.reduce((sum, day) => sum + day.total, 0),
  window: {
    range: '7d',
    bucket: 'day',
    start: days[0]!.start,
    end: days.at(-1)!.start,
    from: days[0]!.from,
    before: days.at(-1)!.before,
    timeZone: 'Europe/Berlin',
  },
  sourceFilter: 'applied',
  coverage: {
    state: 'partial',
    sources: [
      {
        connectionId: '66666666-6666-4666-8666-666666666666',
        label: 'Tokyo store',
        system: 'shopify',
        state: 'limited',
        historyFrom: '2026-09-21T00:00:00.000Z',
        dataThrough: '2026-10-01T08:40:00.000Z',
        lastReadAt: '2026-10-01T08:41:00.000Z',
      },
      {
        connectionId: '55555555-5555-4555-8555-555555555555',
        label: 'JTL-Wawi',
        system: 'jtl',
        state: 'complete',
        historyFrom: null,
        dataThrough: '2026-10-01T08:55:00.000Z',
        lastReadAt: '2026-10-01T08:56:00.000Z',
      },
    ],
    excluded: [{ reason: 'no_placed_time', count: 3 }],
  },
  dataThrough: '2026-10-01T08:40:00.000Z',
  asOf,
};

const procurement: InsightChartResponse = {
  chart: 'procurement',
  kind: 'breakdown',
  unit: 'purchase_order',
  series: ['overdue', 'not_overdue'],
  points: [
    ['draft', 2, 0],
    ['awaiting_approval', 1, 0],
    ['sending', 0, 0],
    ['send_failed', 0, 0],
    ['awaiting_confirmation', 3, 2],
    ['confirmed', 4, 1],
    ['changed', 1, 0],
    ['partially_received', 2, 0],
    ['received', 5, 0],
  ].map(([key, onTime, overdue]) => ({
    key: String(key),
    start: null,
    end: null,
    from: null,
    before: null,
    values: { not_overdue: Number(onTime), overdue: Number(overdue) },
    total: Number(onTime) + Number(overdue),
    coverage: 'complete' as const,
  })),
  total: 21,
  window: null,
  sourceFilter: 'not_applicable',
  coverage: { state: 'complete', sources: [], excluded: [] },
  dataThrough: asOf,
  asOf,
};

const stock: InsightChartResponse = {
  ...procurement,
  chart: 'stock',
  unit: 'stock_position',
  series: ['positions'],
  points: [],
  total: 0,
  sourceFilter: 'applied',
  coverage: { state: 'unavailable', sources: [], excluded: [] },
  dataThrough: null,
};

type State = 'orders' | 'procurement' | 'loading' | 'unavailable' | 'error';

function Content({
  state,
  onSelect,
}: {
  state: State;
  onSelect: (selection: Selection) => void;
}) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const data =
    state === 'orders'
      ? orders
      : state === 'procurement'
        ? procurement
        : state === 'unavailable'
          ? stock
          : undefined;
  const error: InsightsError | undefined =
    state === 'error' ? 'unavailable' : undefined;

  return (
    <div style={{ maxWidth: 1000, padding: 24 }}>
      <ChartCard
        chart={data?.chart ?? 'fulfillment'}
        organizationId={org}
        timeZone="Europe/Berlin"
        data={data}
        loading={state === 'loading'}
        refreshing={false}
        error={error}
        selected={selected}
        onSelect={(selection) => {
          setSelected(selection);
          onSelect(selection);
        }}
        onRetry={() => undefined}
      />
    </div>
  );
}

function Preview({
  state = 'orders',
  onSelect,
}: {
  state?: State;
  onSelect: (selection: Selection) => void;
}) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <style>{insightStyles}</style>
            <Content state={state} onSelect={onSelect} />
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Insights/Charts',
  component: Preview,
  args: { onSelect: fn() },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OrdersWithImportedHistory: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chart = await canvas.findByRole('group', {
      name: 'Orders placed, last 7 days',
    });
    const bars = within(chart).getAllByRole('button');
    await expect(bars[0]).toHaveAccessibleName(
      'Fri 18 Sept: Not imported: this period is before the imported history, so its count is unknown.',
    );
    await expect(canvas.getByText(/without a placed time/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /^Open\s*39$/ }));
    await expect(args.onSelect).toHaveBeenLastCalledWith({ series: 'open' });
    await userEvent.click(canvas.getByRole('tab', { name: 'Table' }));
    const table = canvas.getByRole('table', {
      name: 'Orders placed, last 7 days',
    });
    await expect(within(table).getAllByText('Not imported')).toHaveLength(3);
  },
};

export const OrdersDark: Story = { globals: { theme: 'dark' } };

export const OrdersNarrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const PurchaseOrderStages: Story = { args: { state: 'procurement' } };

export const PurchaseOrderStagesDark: Story = {
  args: { state: 'procurement' },
  globals: { theme: 'dark' },
};

export const NothingCanReport: Story = {
  args: { state: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/stock risk is unknown, not zero/),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('group', { name: 'Stock risk' }),
    ).toBeNull();
  },
};

export const Loading: Story = { args: { state: 'loading' } };

export const Unavailable: Story = {
  args: { state: 'error' },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('alert'),
    ).toHaveTextContent('Chart unavailable');
  },
};
