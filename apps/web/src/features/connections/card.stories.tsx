import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ConnectionCard } from './connection-card';
import {
  ConnectionsPreview,
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
    await expect(
      await d.findByLabelText('Access token', {}, { timeout: 5000 }),
    ).toHaveAttribute('type', 'password');
  },
};

export const DisconnectConfirmation: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', {
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
    await expect(
      await d.findByLabelText('Shop hostname', {}, { timeout: 5000 }),
    ).toBeDisabled();
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

export const Revoked: Story = {
  args: { connection: { ...warehouse, status: 'revoked' } },
};
