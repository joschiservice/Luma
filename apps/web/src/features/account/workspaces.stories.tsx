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
import { WorkspaceRows } from './workspaces';

const workspace = (
  id: number,
  name: string,
  patch: Partial<
    Parameters<typeof WorkspaceRows>[0]['workspaces'][number]
  > = {},
) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  name,
  status: 'active' as const,
  membershipStatus: 'active' as const,
  dataDeletionAt: null,
  dataDeletedAt: null,
  ...patch,
});

const workspaces = [
  workspace(1, 'Northwind Retail'),
  workspace(2, 'Harbor Goods', { membershipStatus: 'suspended' }),
  workspace(3, 'Atlas Outdoor', {
    status: 'closed',
    dataDeletionAt: '2099-11-02T00:00:00.000Z',
  }),
  workspace(4, 'Cobalt Studio', { status: 'closed' }),
  workspace(5, 'Juniper Home', {
    status: 'closed',
    dataDeletionAt: '2026-09-01T00:00:00.000Z',
    dataDeletedAt: '2026-09-01T03:00:00.000Z',
  }),
];

function Preview() {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <>
            <style>{appStyles}</style>
            <main className="entry-panel">
              <WorkspaceRows workspaces={workspaces} />
            </main>
          </>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Account/Workspaces',
  component: Preview,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ClosedWorkspaces: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Open workspaces link to Home; closed ones can't be opened and say what happens to data.
    await expect(
      await canvas.findByRole('link', { name: /Northwind Retail/ }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('link', { name: /Atlas Outdoor/ }),
    ).toBeNull();
    await expect(canvas.getAllByText('Closed')).toHaveLength(3);
    await expect(canvas.getByText(/Nov 2099/)).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Narrow: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
