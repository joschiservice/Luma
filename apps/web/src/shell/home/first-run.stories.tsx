import type { OperationsOverview } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

import { contextFixture } from '../../kit/identity/context.fixture';
import { contextOptions } from '../../kit/identity/data';
import appStyles from '../../styles.css?inline';
import { FirstRun } from './first-run';
import homeStyles from './home.css?inline';

const organizationId = '11111111-1111-4111-8111-111111111111';

const empty: OperationsOverview = {
  generatedAt: '2026-09-30T12:00:00Z',
  window: { start: '2026-09-29T12:00:00Z', end: '2026-09-30T12:00:00Z' },
  freshnessThresholdHours: 24,
  connections: [],
  attentionCount: 0,
  activeCount: 0,
  verifiedResolutions: 0,
  automaticallyResolved: null,
  automation: null,
  prioritizedDecisions: [],
};

const importing: OperationsOverview = {
  ...empty,
  connections: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      label: 'Main shop',
      status: 'active',
      lastObservedAt: null,
      freshness: 'unobserved',
    },
  ],
};

function Preview({
  role,
  data,
}: {
  role: 'owner' | 'member';
  data: OperationsOverview;
}) {
  const [client] = useState(() => {
    const value = new QueryClient();
    value.setQueryData(
      contextOptions(organizationId).queryKey,
      contextFixture(organizationId, role),
    );

    return value;
  });
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>
              {appStyles}
              {homeStyles}
            </style>
            <FirstRun organizationId={organizationId} data={data} />
          </>
        ),
      }),
    }),
  );

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Home/First run',
  component: Preview,
  args: { role: 'owner', data: empty },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const OwnerWithoutConnections: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Connect Shopify' }),
    ).toHaveAttribute('href', `/app/${organizationId}/apps?install=shopify`);
    const steps = canvas.getByRole('list', { name: 'Setup steps' });
    await expect(steps).toHaveTextContent('Your next step');
  },
};

export const MemberWithoutConnections: Story = {
  args: { role: 'member' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Ask a workspace owner to connect a system.');
    await expect(
      canvas.queryByRole('link', { name: 'Connect Shopify' }),
    ).toBeNull();
  },
};

export const WaitingForFirstImport: Story = {
  args: { data: importing },
  play: async ({ canvasElement }) => {
    const steps = within(canvasElement).getByRole('list', {
      name: 'Setup steps',
    });
    await expect(steps).toHaveTextContent('Done');
    await expect(steps).toHaveTextContent('Luma is working on it');
  },
};
