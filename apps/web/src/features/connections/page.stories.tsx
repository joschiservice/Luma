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
      await c.findByRole('heading', { name: 'Shopify' }),
    ).toBeVisible();
    await expect(c.getByRole('heading', { name: 'JTL' })).toBeVisible();
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
      (await c.findAllByRole('link', { name: 'Manage app' }))[0]!,
    ).toBeVisible();
    await expect(
      c.queryByRole('button', { name: 'Validate access' }),
    ).not.toBeInTheDocument();
  },
};

export const ShopifySetup: Story = {
  parameters: { connectionState: 'empty' },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Install Shopify',
      }),
    );
    // Installing asks for consent to the access the app requests.
    await userEvent.click(
      within(await within(document.body).findByRole('dialog')).getByRole(
        'button',
        { name: 'Install Shopify' },
      ),
    );
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Add connection',
      }),
    );
    const dialog = await within(document.body).findByRole('dialog');
    await waitFor(
      () =>
        expect(within(dialog).getByLabelText('Shop hostname')).toBeVisible(),
      { timeout: 5000 },
    );
  },
};

export const JtlCloudSetup: Story = {
  parameters: { connectionState: 'empty' },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Install JTL',
      }),
    );
    // Installing asks for consent to the access the app requests.
    await userEvent.click(
      within(await within(document.body).findByRole('dialog')).getByRole(
        'button',
        { name: 'Install JTL' },
      ),
    );
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Add connection',
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
  parameters: { connectionState: 'empty' },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Install JTL',
      }),
    );
    // Installing asks for consent to the access the app requests.
    await userEvent.click(
      within(await within(document.body).findByRole('dialog')).getByRole(
        'button',
        { name: 'Install JTL' },
      ),
    );
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Add connection',
      }),
    );
    const dialog = await within(document.body).findByRole('dialog');
    await userEvent.selectOptions(
      await within(dialog).findByLabelText('Connection type'),
      'jtl-onprem',
    );
    await expect(
      within(dialog).getByLabelText('Challenge code'),
    ).toHaveAttribute('type', 'password');
  },
};
