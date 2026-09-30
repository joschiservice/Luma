import type { SyncOverview } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { SyncView } from './page';
import { attention, current, importing, organizationId } from './sync-fixtures';

const overviews: Record<string, SyncOverview | undefined> = {
  importing,
  current,
  attention,
  empty: { ...importing, connections: [], runs: [] },
};

function Preview({
  state = 'importing',
  canManage = true,
}: {
  state?: string;
  canManage?: boolean;
}) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <SyncView
              organizationId={organizationId}
              overview={overviews[state]}
              loading={state === 'loading'}
              error={
                state === 'error'
                  ? 'Sync status could not be loaded.'
                  : undefined
              }
              canManage={canManage}
              command={() => undefined}
              refresh={() => undefined}
            />
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Data sync/Workspace',
  component: Preview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Importing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Importing history' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('progressbar', { name: 'Orders history import' }),
    ).toHaveAttribute('aria-valuetext', '1,240 of 3,100 orders');
    await expect(canvas.getByText('Waiting for orders')).toBeVisible();
  },
};

export const ImportingDark: Story = { globals: { theme: 'dark' } };

export const UpToDate: Story = {
  args: { state: 'current' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Only recent orders were shared'),
    ).toBeVisible();
    await expect(
      canvas.getByText(/didn’t share orders placed before Jul 31, 2026/),
    ).toBeVisible();
  },
};

export const NeedsAttention: Story = {
  args: { state: 'attention' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: '2 syncs need attention' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: /Resume with my access/ }),
    ).toBeVisible();
  },
};

export const NeedsAttentionDark: Story = {
  args: { state: 'attention' },
  globals: { theme: 'dark' },
};

export const ReadOnlyMember: Story = {
  args: { state: 'attention', canManage: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole('button', { name: /sync actions/ }),
    ).toBeNull();
  },
};

export const NoConnections: Story = { args: { state: 'empty' } };

export const Loading: Story = { args: { state: 'loading' } };

export const LoadFailed: Story = { args: { state: 'error' } };
