import type {
  MetricResponse,
  OperationalMetricResponse,
} from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import type { LiveMetricView, MetricInspector } from '../overview/metrics-live';
import { AttentionSummary } from './attention-summary';
import insightStyles from './insights.css?inline';

const asOf = '2026-10-01T09:00:00.000Z';

type OperationalMetric = OperationalMetricResponse['metrics'][number];

const operationalMetric = (
  id: OperationalMetric['definition']['id'],
  value: number | null,
): OperationalMetric => ({
  definition: {
    id,
    title: id,
    description: id,
    version: 2,
    family: id.startsWith('cases.') ? 'cases' : 'inventory',
    unit: id.startsWith('cases.') ? 'case' : 'stock_position',
    filters: [],
    timeSemantics: 'Current state.',
    permissions: 'workspace_member',
  },
  value,
  total: value,
  observedCount: value ?? 0,
  unknownCount: 0,
  population: value ?? 0,
  coverage: value === null ? 'unavailable' : 'complete',
  coverageExplanation: '',
  freshness: 'fresh',
  observedAt: asOf,
  dataThrough: asOf,
  nextRefreshAt: null,
  breakdown: [],
  offset: 0,
  nextCursor: null,
  items: [],
});

const operational = (
  attention: number,
  below: number | null,
): OperationalMetricResponse => ({
  definitionVersion: 2,
  scope: {},
  asOf,
  readAt: asOf,
  timezone: 'UTC',
  nextRefreshAt: null,
  limit: 20,
  metrics: [
    operationalMetric('cases.attention', attention),
    operationalMetric('inventory.below_minimum', below),
    operationalMetric(
      'inventory.replenishment_unknown',
      below === null ? null : 0,
    ),
  ],
});

const orders = (attention: number): MetricResponse => ({
  definitionVersion: 1,
  scope: {},
  asOf,
  readAt: asOf,
  timezone: 'UTC',
  observedAt: asOf,
  dataThrough: asOf,
  freshness: 'fresh',
  coverage: 'partial',
  coverageExplanation: '',
  limit: 20,
  metrics: [
    {
      definition: {
        id: 'orders.attention',
        title: 'Orders needing you',
        description: '',
        predicate: '',
        timeSemantics: '',
        version: 1,
        unit: 'canonical_order',
        dimensions: [],
        filters: [],
        permissions: 'workspace_member',
        drillDown: 'orders.cohort',
      },
      total: attention,
      observedCount: attention,
      unknownCount: 0,
      offset: 0,
      nextCursor: null,
      items: [],
    },
  ],
});

const view = <Response,>(data: Response): LiveMetricView<Response> => ({
  data,
  error: null,
  isError: false,
  isPending: false,
  isFetching: false,
  isPaused: false,
  refetch: () => undefined,
  updatedAt: 1,
  connection: 'live',
});

type State = 'attention' | 'clear' | 'unknown';

const data = {
  attention: [operational(2, 3), orders(1)],
  clear: [operational(0, 0), orders(0)],
  unknown: [operational(0, null), orders(0)],
} as const;

function Preview({
  state,
  onInspect,
}: {
  state: State;
  onInspect: (metric: string) => void;
}) {
  const inspector = useRef<MetricInspector>({
    inspect: (metric) => onInspect(metric),
  });
  const [operationalData, ordersData] = data[state];

  return (
    <div style={{ maxWidth: 1000, padding: 24 }}>
      <style>{appStyles}</style>
      <style>{insightStyles}</style>
      <AttentionSummary
        operational={view(operationalData)}
        orders={view(ordersData)}
        operationalInspector={inspector}
        ordersInspector={inspector}
      />
    </div>
  );
}

const meta = {
  title: 'Insights/Attention summary',
  component: Preview,
  args: { state: 'attention', onInspect: fn() },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const summary = canvas.getByRole('region', { name: 'Needs attention' });
    // Only nonzero counts are listed, in the order a person works through them.
    await expect(
      within(summary)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      '2Issues needing attention',
      '3Stock positions below minimum',
      '1Orders needing you',
    ]);
    await userEvent.click(
      canvas.getByRole('button', { name: /Stock positions below minimum/ }),
    );
    await expect(args.onInspect).toHaveBeenLastCalledWith(
      'inventory.below_minimum',
    );
  },
};

export const NeedsAttentionDark: Story = { globals: { theme: 'dark' } };

export const NothingWaiting: Story = {
  args: { state: 'clear' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('Nothing needs attention right now.'),
    ).toBeVisible();
  },
};

// An unknown count is never reported as nothing waiting.
export const SomeCountsUnknown: Story = {
  args: { state: 'unknown' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        'No known count needs attention, but some counts are unknown.',
      ),
    ).toBeVisible();
  },
};
