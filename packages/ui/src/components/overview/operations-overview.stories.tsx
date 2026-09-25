import type { OperationsOverview as Summary } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { inventoryCase } from '../issues/case-fixtures';
import { OperationsOverview } from './operations-overview';

const data: Summary = {
  generatedAt: '2026-09-19T09:00:00.000Z',
  window: {
    start: '2026-09-18T09:00:00.000Z',
    end: '2026-09-19T09:00:00.000Z',
  },
  freshnessThresholdHours: 24,
  connections: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Shopify · Main store',
      status: 'active',
      freshness: 'fresh',
      lastObservedAt: '2026-09-19T08:55:00.000Z',
    },
  ],
  attentionCount: 0,
  activeCount: 0,
  verifiedResolutions: 12,
  automaticallyResolved: 9,
  automation: { numerator: 9, denominator: 12 },
  prioritizedDecisions: [],
};

const meta = {
  title: 'Operations/Overview',
  component: OperationsOverview,
  parameters: { layout: 'fullscreen' },
  args: {
    data,
    window: '24h',
    onWindowChange: fn(),
    onRefresh: fn(),
    connectionsLink: <a href="#connections">Manage connections →</a>,
    inboxLink: <a href="#inbox">Open attention inbox →</a>,
    decisionLink: (item) => (
      <a href={`#${item.id}`}>{item.summary.replace(/\.+$/, '')}</a>
    ),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: 24, background: 'var(--background)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OperationsOverview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Healthy: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Observed operations look healthy.'),
    ).toBeVisible();
    await expect(canvas.getByText('75%')).toBeVisible();
    await expect(
      canvas.getByText(
        '9 / 12 eligible issues resolved correctly without human work.',
      ),
    ).toBeVisible();
    const select = canvas.getByRole('combobox', { name: 'Resolution window' });
    select.focus();
    await expect(select).toHaveFocus();
    await userEvent.click(select);
    await userEvent.click(
      await within(document.body).findByRole('option', { name: 'Last 7 days' }),
    );
    await expect(args.onWindowChange).toHaveBeenCalledWith('7d');
    await waitFor(() => expect(select).toHaveFocus());
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Refresh' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onRefresh).toHaveBeenCalled();
    await userEvent.tab();
    await expect(
      canvas.getAllByRole('link', { name: 'Manage connections →' })[0],
    ).toHaveFocus();
  },
};

export const AttentionNeeded: Story = {
  args: {
    data: {
      ...data,
      attentionCount: 1,
      activeCount: 3,
      prioritizedDecisions: [inventoryCase],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'A few decisions need you.' }),
    ).toBeVisible();
    const link = canvas.getByRole('link', {
      name: inventoryCase.summary.replace(/\.+$/, ''),
    });
    link.focus();
    await expect(link).toHaveFocus();
    await expect(link).toHaveAttribute('href', `#${inventoryCase.id}`);
  },
};

export const Onboarding: Story = {
  args: {
    data: {
      ...data,
      connections: [],
      verifiedResolutions: 0,
      automaticallyResolved: null,
      automation: null,
    },
  },
};

export const NoObservations: Story = {
  args: {
    data: {
      ...data,
      connections: data.connections.map((c) => ({
        ...c,
        freshness: 'unobserved',
        lastObservedAt: null,
      })),
    },
  },
};

export const Stale: Story = {
  args: {
    data: {
      ...data,
      connections: data.connections.map((c) => ({
        ...c,
        freshness: 'stale',
        lastObservedAt: '2026-09-17T08:55:00.000Z',
      })),
    },
  },
};

export const Degraded: Story = {
  args: {
    data: {
      ...data,
      connections: data.connections.map((c) => ({ ...c, status: 'degraded' })),
    },
  },
};

export const AttributionUnavailable: Story = {
  args: { data: { ...data, automaticallyResolved: null, automation: null } },
};

export const NoEligibleExceptions: Story = {
  args: {
    data: {
      ...data,
      automaticallyResolved: 0,
      automation: { numerator: 0, denominator: 0 },
    },
  },
};

export const Loading: Story = {
  args: { data: undefined, loading: true, refreshing: true },
};

export const ServiceFailure: Story = {
  args: { error: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('75%')).not.toBeInTheDocument();
    await expect(
      canvas.queryByText('Observed operations look healthy.'),
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(args.onRefresh).toHaveBeenCalled();
  },
};

const retired: Summary['connections'][number] = {
  ...data.connections[0]!,
  id: '33333333-3333-4333-8333-333333333333',
  label: 'Previous store',
  status: 'disconnected',
  freshness: 'unobserved',
  lastObservedAt: null,
};

export const HealthyWithRetiredConnection: Story = {
  args: { data: { ...data, connections: [...data.connections, retired] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Observed operations look healthy.'),
    ).toBeVisible();
    await expect(
      canvas.getByText('disconnected · Not monitored'),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Check your connections.'),
    ).not.toBeInTheDocument();
  },
};

export const AllConnectionsRetired: Story = {
  args: { data: { ...data, connections: [retired] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'No connected systems.' }),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Observed operations look healthy.'),
    ).not.toBeInTheDocument();
  },
};

export const RevokedConnection: Story = {
  args: {
    data: {
      ...data,
      connections: [...data.connections, { ...retired, status: 'revoked' }],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('Check your connections.'),
    ).toBeVisible();
  },
};

export const OfflineAfterSuccess: Story = {
  args: { paused: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText('Updates paused while offline'),
    ).toBeVisible();
    await expect(
      canvas.queryByText('Observed operations look healthy.'),
    ).not.toBeInTheDocument();
    await expect(canvas.queryByText('75%')).not.toBeInTheDocument();
    await expect(
      canvas.getByRole('button', { name: 'Refresh' }),
    ).toBeDisabled();
  },
};

export const OfflineBeforeFirstLoad: Story = {
  args: { paused: true, loading: true, data: undefined },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('Updates paused while offline'),
    ).toBeVisible();
  },
};
