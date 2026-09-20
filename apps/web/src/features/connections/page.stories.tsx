import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Connections } from './page';
import {
  ConnectionsPreview,
  mockConnections,
  type MockState,
  organizationId,
} from './storybook-support';

const meta = {
  title: 'Connections/Page',
  component: Connections,
  args: { organizationId },
  parameters: { layout: 'fullscreen' },
  beforeEach: (context) =>
    mockConnections(
      context.parameters.connectionState as MockState | undefined,
    ),
  decorators: [
    (Story) => (
      <ConnectionsPreview>
        <Story />
      </ConnectionsPreview>
    ),
  ],
} satisfies Meta<typeof Connections>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Installed: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(
      await c.findByRole('heading', { name: 'Main store' }),
    ).toBeVisible();
    await expect(
      c.getByRole('heading', { name: 'North warehouse' }),
    ).toBeVisible();
    await userEvent.click(c.getByRole('button', { name: 'Refresh list' }));
    await expect(
      await c.findByRole('button', { name: 'Refresh list' }),
    ).toBeEnabled();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Empty: Story = { parameters: { connectionState: 'empty' } };

export const Loading: Story = { parameters: { connectionState: 'loading' } };

export const ServiceUnavailable: Story = {
  parameters: { connectionState: 'error' },
};

export const ReadOnly: Story = {
  parameters: { connectionState: 'member' },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(
      await c.findByRole('button', { name: 'Connect Shopify' }),
    ).toBeDisabled();
    await expect(
      c.queryByRole('button', { name: 'Validate access' }),
    ).not.toBeInTheDocument();
  },
};

export const ShopifyConnected: Story = { args: { shopifyResult: 'connected' } };

export const ShopifyDenied: Story = { args: { shopifyResult: 'denied' } };

export const ShopifyPermissions: Story = {
  args: { shopifyResult: 'permissions' },
};

export const ShopifySetup: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Connect Shopify',
      }),
    );
    const dialog = await within(document.body).findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Shop hostname')).toBeVisible(),
    );
  },
};

export const JtlCloudSetup: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Set up JTL Cloud',
      }),
    );
    const dialog = await within(document.body).findByRole('dialog');
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText('JTL Cloud tenant ID'),
      ).toBeVisible(),
    );
  },
};

export const JtlOnPremiseSetup: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Set up JTL-Wawi on-premise',
      }),
    );
    const dialog = await within(document.body).findByRole('dialog');
    await expect(
      within(dialog).getByLabelText('Challenge code'),
    ).toHaveAttribute('type', 'password');
  },
};

export const DisconnectFlow: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const card = await c.findByRole('article', { name: 'North warehouse' });
    await userEvent.click(
      within(card).getByRole('button', { name: 'Disconnect' }),
    );
    const dialog = await within(document.body).findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Confirm disconnect' }),
    );
    await expect(
      await within(card).findByText('Disconnected', { exact: true }),
    ).toBeVisible();
    await expect(
      within(card).queryByRole('button', { name: 'Validate access' }),
    ).not.toBeInTheDocument();
  },
};
