import type { SyncOverview } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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
import {
  attention,
  current,
  importing,
  organizationId,
  recentHistory,
} from './sync-fixtures';

const overviews: Record<string, SyncOverview | undefined> = {
  importing,
  recentHistory,
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
              error={state === 'error' ? m.sync_load_failed() : undefined}
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
      canvas.getByText(/didn’t share orders placed before 31 Jul 2026/),
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

export const RecentHistoryAvailable: Story = {
  args: { state: 'recentHistory' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Recent history imported'),
    ).toBeVisible();
    await expect(canvas.getByText('Preparing history')).toBeVisible();
    await expect(
      canvas.getByText('The source is preparing an export'),
    ).toBeVisible();
    await expect(
      canvas.getByText(
        /^Orders since.*Older history continues to import in the background/,
      ),
    ).toBeVisible();
  },
};

export const RecentHistoryDark: Story = {
  args: { state: 'recentHistory' },
  globals: { theme: 'dark' },
};
