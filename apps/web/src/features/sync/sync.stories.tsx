import type { SyncOverview, SyncRecordState } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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
import { SyncView } from './page';
import {
  attention,
  current,
  disconnected,
  importing,
  opportunities,
  orderRuns,
  organizationId,
  productProblems,
  rateLimited,
  recentHistory,
  shopify,
  waiting,
} from './sync-fixtures';

const overviews: Record<string, SyncOverview | undefined> = {
  importing,
  recentHistory,
  waiting,
  current,
  rateLimited,
  attention,
  opportunities,
  disconnected,
  empty: { ...importing, connections: [], runs: [] },
};

const shopifyOrders = shopify.recordTypes[0]!.stream!.id;

const jtlProducts = opportunities.connections[1]!.recordTypes.find(
  (item) => item.recordType === 'products',
)!.stream!.id;

function Preview({
  state = 'importing',
  canManage = true,
  open: initial,
}: {
  state?: string;
  canManage?: boolean;
  /** The sync open in the detail pane when the story starts. */
  open?: string;
}) {
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({ component: () => <Workspace /> }),
    }),
  );

  function Workspace() {
    const [open, setOpen] = useState(initial);
    const [listed, setListed] = useState<SyncRecordState | null>(null);

    return (
      <>
        <style>{appStyles}</style>
        <SyncView
          organizationId={organizationId}
          overview={overviews[state]}
          loading={state === 'loading'}
          error={state === 'error' ? m.sync_load_failed() : undefined}
          canManage={canManage}
          open={open}
          onOpenChange={setOpen}
          history={{
            runs: open === shopifyOrders ? orderRuns : [],
            loading: false,
            error: false,
            more: open === shopifyOrders,
            loadMore: () => undefined,
          }}
          records={{
            state: listed,
            onStateChange: setListed,
            records: listed === 'failed' ? productProblems : [],
            loading: false,
            error: false,
            more: false,
            loadingMore: false,
            loadMore: () => undefined,
          }}
          command={() => undefined}
          commandAll={() => undefined}
          refresh={() => undefined}
        />
      </>
    );
  }

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
    // Record types the connection doesn't sync collapse into one line.
    await expect(
      canvas.getAllByText('Not part of this connection: Customers')[0],
    ).toBeVisible();
    await expect(
      canvas.getByRole('list', { name: 'Syncs by state' }),
    ).toHaveTextContent('1 retrying');
  },
};

export const ImportingDark: Story = { globals: { theme: 'dark' } };

export const OpenImport: Story = {
  args: { open: shopifyOrders },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = await canvas.findByRole('region', { name: 'Sync details' });
    const detail = within(pane);
    await expect(
      detail.getByRole('heading', { name: 'Orders · Shopify · Japan' }),
    ).toBeVisible();
    await expect(
      detail.getByRole('heading', { name: 'History import' }),
    ).toBeVisible();
    await expect(detail.getByText('Recent history import')).toBeVisible();
    await expect(
      detail.getByRole('button', { name: 'Check all records' }),
    ).toBeDisabled();
    await expect(
      detail.getByText('Available once the history import finishes.'),
    ).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: 'Orders: Importing history' }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      detail.getByRole('button', { name: 'Show older runs' }),
    ).toBeVisible();
  },
};

export const OpenImportDark: Story = {
  args: { open: shopifyOrders },
  globals: { theme: 'dark' },
};

export const OpenWithKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: 'Importing history' });
    await userEvent.keyboard('j');
    await userEvent.keyboard(' ');
    const pane = await canvas.findByRole('region', { name: 'Sync details' });
    await expect(
      within(pane).getByRole('heading', { name: 'Orders · Shopify · Japan' }),
    ).toBeVisible();
    await userEvent.keyboard('j');
    await expect(
      await within(pane).findByRole('heading', {
        name: 'Fulfillments · Shopify · Japan',
      }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(
      canvas.queryByRole('region', { name: 'Sync details' }),
    ).toBeNull();
  },
};

export const UpToDate: Story = {
  args: {
    state: 'current',
    open: current.connections[0]!.recordTypes[0]!.stream!.id,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Up to date' }),
    ).toBeVisible();
    await expect(
      canvas.getByText('3,100 orders · shared from 31 Jul 2026'),
    ).toBeVisible();
    await expect(
      canvas.getByText(/Importing older orders needs more access/),
    ).toBeVisible();
    await expect(
      canvas.queryByRole('heading', { name: 'Needs attention' }),
    ).toBeNull();
  },
};

export const NeedsAttention: Story = {
  args: { state: 'attention' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: '2 syncs need attention' }),
    ).toBeVisible();
    const section = within(
      canvas.getByRole('region', { name: /Needs attention/ }),
    );
    await expect(
      section.getByRole('button', { name: /Resume with my access/ }),
    ).toBeVisible();
    await expect(section.getByText('Failed 6 times in a row')).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Retry now' }),
    ).toBeVisible();
  },
};

export const NeedsAttentionDark: Story = {
  args: { state: 'attention' },
  globals: { theme: 'dark' },
};

export const Opportunities: Story = {
  args: { state: 'opportunities' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Older orders are now available'),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Import older orders' }),
    ).toBeVisible();
    await expect(canvas.getByText('Couldn’t import 2 products')).toBeVisible();
    await expect(canvas.getByText('2 products couldn’t import')).toBeVisible();
  },
};

export const FailedRecords: Story = {
  args: { state: 'opportunities', open: jtlProducts },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = within(
      await canvas.findByRole('region', { name: 'Sync details' }),
    );
    const toggle = pane.getByRole('button', { name: 'Show products' });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = pane.getByRole('list', {
      name: '2 products couldn’t import',
    });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await expect(within(list).getByText('10442')).toBeVisible();
    // Only the record Luma imported before can be found in Records.
    await expect(
      within(list).getByRole('link', {
        name: 'Find source record 10518 in Records',
      }),
    ).toHaveAttribute(
      'href',
      expect.stringMatching(/\/records\?q=.*10518.*&connectionId=/),
    );
    await expect(within(list).getAllByRole('link')).toHaveLength(1);
    await userEvent.click(pane.getByRole('button', { name: 'Hide' }));
    await expect(
      pane.queryByRole('list', { name: '2 products couldn’t import' }),
    ).toBeNull();
  },
};

export const FailedRecordsDark: Story = {
  args: { state: 'opportunities', open: jtlProducts },
  globals: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = within(
      await canvas.findByRole('region', { name: 'Sync details' }),
    );
    await userEvent.click(pane.getByRole('button', { name: 'Show products' }));
  },
};

export const ConnectionDisconnected: Story = {
  args: { state: 'disconnected' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('JTL-Wawi isn’t active'),
    ).toBeVisible();
  },
};

export const ReadOnlyMember: Story = {
  args: { state: 'attention', canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole('button', { name: /sync actions/ }),
    ).toBeNull();
    await expect(
      canvas.queryByRole('button', { name: /Resume with my access/ }),
    ).toBeNull();
  },
};

export const ReadOnlyDetail: Story = {
  args: { canManage: false, open: shopifyOrders },
  play: async ({ canvasElement }) => {
    const pane = within(
      await within(canvasElement).findByRole('region', {
        name: 'Sync details',
      }),
    );
    await expect(
      pane.getByText(/Your role can follow this sync but not change it/),
    ).toBeVisible();
    await expect(pane.queryByRole('button', { name: 'Pause' })).toBeNull();
  },
};

export const MissingSync: Story = {
  args: { open: '99999999-9999-4999-8999-999999999999' },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText('This sync isn’t available'),
    ).toBeVisible();
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
      await canvas.findByText('3,100 orders so far · recent history complete'),
    ).toBeVisible();
    await expect(canvas.getByText('Preparing history')).toBeVisible();
    await expect(
      canvas.getByText('The source is preparing an export'),
    ).toBeVisible();
  },
};

export const RecentHistoryDetail: Story = {
  args: {
    state: 'recentHistory',
    open: recentHistory.connections[0]!.recordTypes[0]!.stream!.id,
  },
  play: async ({ canvasElement }) => {
    const pane = within(
      await within(canvasElement).findByRole('region', {
        name: 'Sync details',
      }),
    );
    await expect(
      pane.getByText(/^Recent history since 30 Aug 2026/),
    ).toBeVisible();
    await expect(pane.getByText(/^Older history/)).toBeVisible();
    await expect(
      pane.getByText(
        /^Orders since.*Older history continues to import in the background/,
      ),
    ).toBeVisible();
  },
};

export const RecentHistoryDark: Story = {
  args: { state: 'recentHistory' },
  globals: { theme: 'dark' },
};

export const Waiting: Story = {
  args: { state: 'waiting' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Waiting to sync' }),
    ).toBeVisible();
    await expect(canvas.getByText('1,240 of 3,100 orders')).toBeVisible();
    await expect(
      canvas.queryByRole('progressbar', { name: 'Orders history import' }),
    ).not.toBeInTheDocument();
  },
};

export const WaitingDetail: Story = {
  args: { state: 'waiting', open: shopifyOrders },
  play: async ({ canvasElement }) => {
    const pane = within(
      await within(canvasElement).findByRole('region', {
        name: 'Sync details',
      }),
    );
    await expect(
      pane.getByText('Waiting for sync capacity. Currently syncing: JTL-Wawi.'),
    ).toBeVisible();
  },
};

export const WaitingDark: Story = {
  args: { state: 'waiting' },
  globals: { theme: 'dark' },
};

export const RateLimited: Story = {
  args: { state: 'rateLimited' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const waiting = await canvas.findByRole('link', {
      name: 'Orders: Waiting for rate limit',
    });
    const retrying = canvas.getByRole('link', {
      name: 'Orders: Retrying after rate limit',
    });
    await expect(
      within(waiting).getByText('1,240 of 3,100 orders'),
    ).toBeVisible();
    await expect(
      within(waiting).getByText('Next retry in 1 minute'),
    ).toBeVisible();
    await expect(
      within(retrying).getByText('Next retry in 1 minute'),
    ).toBeVisible();
  },
};

export const RateLimitedDetail: Story = {
  args: {
    state: 'rateLimited',
    open: rateLimited.connections[1]!.recordTypes[0]!.stream!.id,
  },
  play: async ({ canvasElement }) => {
    const pane = within(
      await within(canvasElement).findByRole('region', {
        name: 'Sync details',
      }),
    );
    await expect(
      pane.getByText(
        'The source’s request limit has been reached. Luma will retry automatically.',
      ),
    ).toBeVisible();
  },
};

export const RateLimitedDark: Story = {
  ...RateLimited,
  globals: { theme: 'dark' },
};

export const Narrow: Story = {
  args: { state: 'attention' },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
