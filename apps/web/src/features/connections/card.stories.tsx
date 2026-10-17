import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ConnectionCard } from '../apps/connection-card';
import {
  ConnectionsPreview,
  loadAppUi,
  mockConnections,
  organizationId,
  shopify,
  warehouse,
} from './storybook-support';

const meta = {
  title: 'Connections/Connection card',
  component: ConnectionCard,
  args: {
    connection: warehouse,
    organizationId,
    canManage: true,
    refresh: fn(async () => {}),
  },
  parameters: { layout: 'fullscreen' },
  loaders: [loadAppUi],
  beforeEach: () => mockConnections(),
  decorators: [
    (Story) => (
      <ConnectionsPreview>
        <div style={{ maxWidth: 680 }}>
          <Story />
        </div>
      </ConnectionsPreview>
    ),
  ],
} satisfies Meta<typeof ConnectionCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Validated: Story = {};

export const Shopify: Story = { args: { connection: shopify } };

export const Pending: Story = {
  args: { connection: { ...warehouse, status: 'pending', granted: [] } },
};

export const Degraded: Story = {
  args: {
    connection: { ...warehouse, status: 'degraded', granted: ['orders.read'] },
  },
};

export const Disconnected: Story = {
  args: { connection: { ...warehouse, status: 'disconnected' } },
};

export const RevokedShopify: Story = {
  args: { connection: { ...shopify, status: 'revoked' } },
};

export const ReadOnly: Story = { args: { canManage: false } };

export const ReplaceCredentials: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Connection settings',
      }),
    );
    const d = within(await within(document.body).findByRole('dialog'));
    await expect(await d.findByLabelText('Access token')).toHaveAttribute(
      'type',
      'password',
    );
  },
};

export const DisconnectConfirmation: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Actions for North warehouse',
      }),
    );
    await userEvent.click(
      await within(document.body).findByRole('menuitem', {
        name: 'Disconnect',
      }),
    );
    const d = within(await within(document.body).findByRole('dialog'));
    await expect(
      d.getByRole('button', { name: 'Confirm disconnect' }),
    ).toBeEnabled();
  },
};

export const ReconnectShopify: Story = {
  args: { connection: { ...shopify, status: 'revoked' } },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Reconnect',
      }),
    );
    const d = within(await within(document.body).findByRole('dialog'));
    await expect(await d.findByLabelText('Shop hostname')).toBeDisabled();
  },
};

export const JtlOnPremise: Story = {
  args: {
    connection: {
      ...warehouse,
      target: {
        kind: 'jtl-onprem',
        baseUrl: 'https://warehouse.example.com/api/',
        appId: 'luma-preview',
        appVersion: '1.0',
      },
    },
  },
};

export const Importing: Story = {
  args: {
    connection: {
      ...warehouse,
      coverage: {
        health: 'importing',
        lastObservedAt: '2026-09-18T00:55:00Z',
        freshness: 'unobserved',
        streams: [
          {
            recordType: 'orders',
            lastSuccessfulAt: '2026-09-18T00:55:00Z',
            lastError: null,
            issueIds: [],
          },
          {
            recordType: 'inventory',
            lastSuccessfulAt: null,
            lastError: null,
            issueIds: [],
          },
        ],
      },
    },
  },
};

export const ReadFailing: Story = {
  args: {
    connection: {
      ...warehouse,
      status: 'degraded',
      granted: ['orders.read', 'products.read'],
      coverage: {
        health: 'failing',
        lastObservedAt: '2026-09-18T00:55:00Z',
        freshness: 'stale',
        streams: [
          {
            recordType: 'orders',
            lastSuccessfulAt: '2026-09-17T08:00:00Z',
            lastError: 'ACCESS_DENIED',
            issueIds: ['55555555-5555-4555-8555-555555555555'],
          },
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Read failing')).toBeVisible();
    // The missing permissions explain the failure, so they open without a click.
    await expect(c.getByText('Correct shipping methods')).toBeVisible();
  },
};

export const OwnerObserveOnly: Story = {
  args: {
    owner: true,
    workspaceWriteMode: 'writes_enabled',
    connection: { ...warehouse, writeMode: 'observe_only' },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText('Observe-only for this connection'),
    ).toBeVisible();
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Actions for North warehouse',
      }),
    );
    const item = await within(document.body).findByRole('menuitem', {
      name: 'Use workspace write mode',
    });
    // The menu fades in; wait for it rather than reading its first frame.
    await waitFor(() => expect(item).toBeVisible());
  },
};

export const Rename: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
        name: 'Actions for North warehouse',
      }),
    );
    await userEvent.click(
      await within(document.body).findByRole('menuitem', { name: 'Rename' }),
    );
    const dialog = within(await within(document.body).findByRole('dialog'));
    const name = dialog.getByLabelText('Connection name');
    await expect(name).toHaveValue('North warehouse');
    await expect(
      dialog.getByRole('button', { name: 'Save name' }),
    ).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, 'Berlin warehouse');
    await userEvent.click(dialog.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(args.refresh).toHaveBeenCalled());
  },
};

export const History: Story = {
  args: { canReadHistory: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText('History'));
    await expect(await c.findByText('Connection renamed')).toBeVisible();
    await expect(c.getByText('Connection added')).toBeVisible();
    await expect(
      c.getByRole('link', { name: 'View all in Activity' }),
    ).toBeVisible();
  },
};

export const Revoked: Story = {
  args: { connection: { ...warehouse, status: 'revoked' } },
};
