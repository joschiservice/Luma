import type { SettingsSnapshot } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
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
import { contextFixture } from '../identity/context.fixture';
import { contextOptions, sessionOptions } from '../identity/data';
import { invitationsOptions, membersOptions } from './data';
import { type SettingsSection, SettingsView } from './page';
import { membersFixture, rolesFixture } from './roles.fixture';
import { rolesOptions } from './roles-data';

const organizationId = '11111111-1111-4111-8111-111111111111';

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
  roleId,
}: {
  section?: SettingsSection;
  state?: 'ready' | 'loading' | 'error' | 'mail-unavailable';
  member?: boolean;
  roleId?: string;
}) {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const context = contextFixture(organizationId, member ? 'member' : 'owner');
    value.setQueryData(contextOptions(organizationId).queryKey, context);
    value.setQueryData(sessionOptions().queryKey, null);
    value.setQueryData(rolesOptions(organizationId).queryKey, rolesFixture);
    value.setQueryData(membersOptions(organizationId).queryKey, membersFixture);
    value.setQueryData(invitationsOptions(organizationId).queryKey, []);

    return value;
  });
  const context = contextFixture(organizationId, member ? 'member' : 'owner');
  const [router] = useState(() =>
    createRouter({
      history: createMemoryHistory(),
      routeTree: createRootRoute({
        component: () => (
          <QueryClientProvider client={client}>
            <style>{appStyles}</style>
            <SettingsView
              section={section}
              roleId={roleId}
              organizationId={organizationId}
              can={(permission) =>
                context.allAppPermissions ||
                context.permissions.includes(permission)
              }
              actorId="22222222-2222-4222-8222-222222222222"
              data={
                state === 'loading' || state === 'error'
                  ? undefined
                  : { ...data, deliveryAvailable: state !== 'mail-unavailable' }
              }
              loading={state === 'loading'}
              error={state === 'error' ? m.settings_load_failed() : undefined}
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
      canvas.getByRole('navigation', { name: 'Settings sections' }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('heading', { name: 'Settings', level: 1 }),
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

export const Roles: Story = {
  args: { section: 'roles' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: /Buyer/ }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole('button', { name: 'Create role' }),
    ).toBeInTheDocument();
  },
};

export const CustomRoleEditor: Story = {
  args: { section: 'roles', roleId: '77777777-7777-4777-8777-777777777777' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grant = canvas.getByRole('switch', { name: /Approve or reject/ });
    await userEvent.click(grant);
    await expect(
      canvas.getByRole('button', { name: 'Review changes' }),
    ).toBeEnabled();
  },
};

export const BuiltInRoleReadOnly: Story = {
  args: { section: 'roles', roleId: 'member', member: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole('switch', { name: /View orders/ }),
    ).toBeNull();
    await expect(canvas.getAllByText('Included').length).toBeGreaterThan(0);
  },
};

export const TeamWithCustomRoles: Story = { args: { section: 'team' } };
