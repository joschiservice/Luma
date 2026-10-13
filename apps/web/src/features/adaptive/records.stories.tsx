import './adaptive.css';

import {
  adaptiveViewPreviewSchema,
  adaptiveViewQuerySchema,
} from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { AdaptiveRecords } from './records';

const configuration = adaptiveViewQuerySchema.parse({
  version: 1,
  domain: 'orders',
  columns: ['displayNumber', 'status', 'placedAt'],
  metrics: [{ id: 'record_count', operation: 'count' }],
  charts: [
    {
      id: 'by_status',
      type: 'bar',
      groupBy: 'status',
      metricId: 'record_count',
    },
  ],
});
const preview = adaptiveViewPreviewSchema.parse({
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      displayNumber: '#48213',
      status: 'open',
      placedAt: '2026-10-13T09:00:00Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      displayNumber: '#48214',
      status: 'completed',
      placedAt: null,
    },
  ],
  asOf: '2026-10-13T09:10:00Z',
  totalCount: 2,
  nextCursor: null,
  warnings: [],
  availableColumns: configuration.columns,
  aggregates: [{ metricId: 'record_count', value: 2, complete: true }],
  chartSeries: [
    {
      id: 'by_status',
      points: [
        { key: 'open', count: 1, value: 1 },
        { key: 'completed', count: 1, value: 1 },
      ],
      complete: true,
      truncated: false,
    },
  ],
});
const meta = {
  title: 'Features/Adaptive workspaces/Records',
  component: AdaptiveRecords,
  args: {
    organizationId: '33333333-3333-4333-8333-333333333333',
    configuration,
    preview,
  },
  decorators: [
    (Story) => (
      <>
        <style>{appStyles}</style>
        <div className="adaptive-workspace">
          <QueryClientProvider
            client={
              new QueryClient({
                defaultOptions: { queries: { enabled: false } },
              })
            }
          >
            <Story />
          </QueryClientProvider>
        </div>
      </>
    ),
  ],
} satisfies Meta<typeof AdaptiveRecords>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LiveTable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: '#48213' })).toBeVisible();
    await expect(canvas.getByText('Unknown', { exact: true })).toBeVisible();
    await expect(
      canvas.getByRole('table', { name: 'Matching records' }),
    ).toBeVisible();
  },
};

export const GroupedBoard: Story = {
  args: {
    configuration: { ...configuration, groupBy: 'status', layout: 'board' },
  },
};

export const IncompleteEvidence: Story = {
  args: {
    preview: {
      ...preview,
      warnings: ['One source could not provide a complete observation.'],
      availableColumns: ['displayNumber', 'status'],
      aggregates: [{ metricId: 'record_count', value: null, complete: false }],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('Unavailable field')[0]).toBeVisible();
  },
};

export const Empty: Story = {
  args: {
    preview: {
      ...preview,
      items: [],
      aggregates: [{ metricId: 'record_count', value: 0, complete: true }],
      chartSeries: [],
    },
  },
};
