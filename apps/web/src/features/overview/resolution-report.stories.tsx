import type { OperationalMetricResponse } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import insightStyles from '../insights/insights.css?inline';
import type { LiveMetricView } from './metrics-live';
import {
  type ReportSearch,
  resolutionReportingRequest,
  ResolutionReportView,
} from './resolution-report';

const org = '33333333-3333-4333-8333-333333333333';
const asOf = '2026-10-01T09:00:00.000Z';
const request = resolutionReportingRequest({ reportWindow: '7d' }, asOf);

function response(partial: boolean, empty: boolean): OperationalMetricResponse {
  return {
    definitionVersion: 2,
    scope: request.scope,
    asOf,
    readAt: asOf,
    timezone: 'UTC',
    nextRefreshAt: null,
    limit: 20,
    metrics: request.metrics.map((id) => {
      const duration =
        id.endsWith('completion_time') || id.endsWith('unresolved_age');
      const value = empty
        ? 0
        : id.endsWith('detected') || id.endsWith('eligible')
          ? 4
          : id.endsWith('completed') || id.endsWith('autonomous')
            ? 2
            : duration
              ? 1800
              : 1;

      return {
        definition: {
          id,
          title: id,
          description: 'Recorded incidents with retained evidence.',
          version: 2,
          family: 'resolution',
          unit: duration ? 'second' : 'case',
          filters: ['start', 'end', 'environment'],
          timeSemantics: 'UTC half-open reporting interval.',
          permissions: 'workspace_member',
        },
        value: empty && duration ? null : value,
        total: partial ? null : value,
        observedCount: empty ? 0 : 2,
        unknownCount: partial ? 1 : 0,
        population: empty ? 0 : 4,
        coverage: empty ? 'unavailable' : partial ? 'partial' : 'complete',
        coverageExplanation: partial
          ? 'Attribution is missing for one recorded incident.'
          : 'Recorded incident cohort; provider completeness is unknown.',
        freshness: 'fresh',
        observedAt: asOf,
        dataThrough: null,
        nextRefreshAt: null,
        offset: 0,
        nextCursor: null,
        items: [],
        breakdown: empty
          ? []
          : id.endsWith('completion_time')
            ? [{ reason: 'duration:5m_1h', count: 2 }]
            : id.endsWith('recurrent')
              ? [{ reason: 'class:inventory_mismatch', count: 1 }]
              : id.endsWith('detected') || id.endsWith('completed')
                ? [{ reason: 'day:2026-09-30', count: value }]
                : [],
      };
    }),
  };
}

type State = 'normal' | 'partial' | 'empty' | 'offline' | 'loading';

function Content({ state }: { state: State }) {
  const [search, setSearch] = useState<ReportSearch>({ reportWindow: '7d' });
  const data =
    state === 'loading'
      ? undefined
      : response(state === 'partial', state === 'empty');
  const view: LiveMetricView<OperationalMetricResponse> = {
    data,
    error: null,
    isError: false,
    isPending: state === 'loading',
    isFetching: state === 'loading',
    isPaused: state === 'offline',
    refetch: fn(),
    updatedAt: 1,
    connection: state === 'offline' ? 'offline' : 'live',
  };

  const selectedRequest = resolutionReportingRequest(search, asOf);

  return (
    <ResolutionReportView
      organizationId={org}
      search={search}
      onSearch={(patch) => setSearch((current) => ({ ...current, ...patch }))}
      request={selectedRequest}
      live={{ resolution: view }}
      previousData={undefined}
      connections={[]}
    />
  );
}

function Frame({ state }: { state: State }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree: createRootRoute({
        component: () => <Content state={state} />,
      }),
    }),
  );

  return (
    <QueryClientProvider client={client}>
      <style>
        {appStyles}
        {insightStyles}
      </style>
      <main style={{ padding: '1.5rem', maxWidth: '75rem' }}>
        <RouterProvider router={router} />
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Insights/Resolution reporting',
  component: Frame,
  args: { state: 'normal' },
} satisfies Meta<typeof Frame>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Normal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('50%', { exact: true })).toBeVisible();
    await expect(
      canvas.getByText('2 of 4 eligible issues resolved without human work.'),
    ).toBeVisible();
    // Recurrence is a table; daily counts and durations are charts until a table is asked for.
    await expect(canvas.getAllByRole('table')).toHaveLength(1);
    const verified = within(
      canvas.getByRole('group', { name: 'Daily counts (UTC) · Verified' }),
    );
    await expect(verified.queryByText('0.5', { exact: true })).toBeNull();
    await expect(verified.getByText('1', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('tab', { name: 'Table' }));
    await expect(
      canvas.getByRole('table', { name: 'Daily counts (UTC)' }),
    ).toBeVisible();
  },
};

export const NormalDark: Story = { globals: { theme: 'dark' } };

export const NormalNarrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const Partial: Story = {
  args: { state: 'partial' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        'An exact autonomous rate is unavailable until eligibility, attribution and environment are complete and the eligible cohort is nonzero.',
      ),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  args: { state: 'empty' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        'No linked recurrences in the recorded cohort. Similar text alone does not establish recurrence.',
      ),
    ).toBeVisible();
  },
};

export const Offline: Story = {
  args: { state: 'offline' },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('Reconnect to load current metrics.'),
    ).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-metric]')).toHaveLength(
      0,
    );
  },
};

export const Loading: Story = { args: { state: 'loading' } };
