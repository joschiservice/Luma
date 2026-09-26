import type { SettingsSnapshot } from '@luma/api-contract';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import appStyles from '../../styles.css?inline';
import { type SettingsSection, SettingsView } from './page';

const data: SettingsSnapshot = {
  workspace: {
    name: 'Northstar Commerce',
    slug: 'northstar-commerce',
    dataRegion: 'EU',
    timezone: 'Europe/Berlin',
    revision: 1,
    alwaysRequireApproval: false,
    policyRevision: 0,
  },
  preferences: { issues: false, connections: false, revision: 0 },
  deliveryAvailable: true,
  lastTest: null,
};

function Preview({
  section = 'workspace',
  state = 'ready',
  member = false,
}: {
  section?: SettingsSection;
  state?: 'ready' | 'loading' | 'error' | 'mail-unavailable';
  member?: boolean;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <style>{appStyles}</style>
            <SettingsView
              section={section}
              organizationId="11111111-1111-4111-8111-111111111111"
              role={member ? 'member' : 'owner'}
              actorId="22222222-2222-4222-8222-222222222222"
              data={
                state === 'loading' || state === 'error'
                  ? undefined
                  : { ...data, deliveryAvailable: state !== 'mail-unavailable' }
              }
              loading={state === 'loading'}
              error={
                state === 'error'
                  ? 'Settings could not be loaded. Check your connection and retry.'
                  : undefined
              }
              retry={() => {}}
            />
          </QueryClientProvider>
        ),
      }),
    }),
  );

  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Settings/Workspace',
  component: Preview,
  render: (args) => <Preview key={JSON.stringify(args)} {...args} />,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Workspace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole('heading', { name: 'Settings' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', { name: 'Save changes' }),
    ).toBeDisabled();
    await userEvent.type(canvas.getByLabelText('Workspace name'), ' Japan');
    await expect(
      canvas.getByRole('button', { name: 'Save changes' }),
    ).toBeEnabled();
  },
};

export const PersonalNotifications: Story = {
  args: { section: 'notifications', member: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('switch', { name: 'Issues that need you' });
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
  },
};

export const Approvals: Story = { args: { section: 'approvals' } };

export const MemberAccess: Story = {
  args: { section: 'workspace', member: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText('Workspace name')).toBeDisabled();
  },
};

export const DeliveryUnavailable: Story = {
  args: { section: 'notifications', state: 'mail-unavailable' },
};

export const Loading: Story = { args: { state: 'loading' } };

export const Unavailable: Story = { args: { state: 'error' } };
