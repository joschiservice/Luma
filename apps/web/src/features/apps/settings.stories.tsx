import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import {
  ConnectionsPreview,
  loadAppUi,
  mockConnections,
  type MockState,
  organizationId,
} from '../connections/storybook-support';
import { AppSettings } from './settings';

const meta = {
  title: 'Apps/Settings',
  component: AppSettings,
  args: { organizationId, appId: 'jtl' },
  parameters: { layout: 'fullscreen' },
  loaders: [loadAppUi],
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
} satisfies Meta<typeof AppSettings>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Installed: Story = {};

export const Dark: Story = { globals: { theme: 'dark' } };

export const ReadOnly: Story = { parameters: { connectionState: 'member' } };

export const ShopifyConnected: Story = {
  args: { appId: 'shopify', appResult: 'connected' },
};

export const ShopifyDenied: Story = {
  args: { appId: 'shopify', appResult: 'denied' },
};

export const ShopifyPermissions: Story = {
  args: { appId: 'shopify', appResult: 'permissions' },
};

export const DisconnectFlow: Story = {
  play: async ({ canvasElement }) => {
    const card = await within(canvasElement).findByRole('article', {
      name: 'North warehouse',
    });
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
