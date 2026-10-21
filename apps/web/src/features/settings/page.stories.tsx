import type { ApiApp, Membership, SettingsSnapshot } from '@luma/api-contract';
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
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { contextFixture } from '../../kit/identity/context.fixture';
import { contextOptions, sessionOptions } from '../../kit/identity/data';
import { invitationsOptions, membersOptions } from '../../kit/settings/data';
import { rolesOptions } from '../../kit/settings/roles-data';
import appStyles from '../../styles.css?inline';
import { type SettingsSection, SettingsView } from './page';
import { membersFixture, rolesFixture } from './roles.fixture';

const organizationId = '11111111-1111-4111-8111-111111111111';

const data: SettingsSnapshot = {
  workspace: {
    name: 'Northstar Commerce',
    slug: 'northstar-commerce',
    dataRegion: 'EU',
    timezone: 'Europe/Berlin',
    revision: 1,
    alwaysRequireApproval: false,
    requireIndependentApproval: true,
    activeMemberCount: 2,
    policyRevision: 0,
    writeMode: 'writes_enabled',
  },
  preferences: {
    issues: false,
    connections: false,
    morningBrief: false,
    morningBriefTime: '08:00',
    revision: 0,
  },
  deliveryAvailable: true,
  emailPaused: null,
  lastTest: null,
};

const apiAppFixture: ApiApp = {
  id: '88888888-8888-4888-8888-888888888888',
  name: 'Weekly sales report',
  scopes: ['customers.read', 'orders.read'],
  status: 'active',
  owner: { userId: '22222222-2222-4222-8222-222222222222', name: 'Mara Owner' },
  createdAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2026-12-30T08:00:00.000Z',
  lastUsedAt: '2026-10-19T06:30:00.000Z',
  lastFour: '3f9a',
  revokedAt: null,
  personalDataReads: { requests: 12, records: 1480 },
};

const apiAppScopesFixture = [
  'orders.read',
  'fulfillment.read',
  'inventory.read',
  'products.read',
  'customers.read',
].map((key) => ({ key, sensitive: key === 'customers.read' }));

// Enough people to need three pages of 25.
const largeTeam: Membership[] = [
  ...membersFixture,
  ...Array.from({ length: 56 }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

    return {
      ...membersFixture[3]!,
      id,
      userId: id,
      name: `Teammate ${index + 1}`,
      email: `teammate${index + 1}@northstar.example`,
    };
  }),
];

/**
 * Answers the team reads with the seeded data. These queries are always stale, so the page
 * fetches them again after mounting, and an unanswered request would show the access error.
 */
function mockTeam({
  member = false,
  team = 'small',
}: {
  member?: boolean;
  team?: 'small' | 'large';
}) {
  const original = globalThis.fetch;
  const answers: Record<string, unknown> = {
    context: contextFixture(organizationId, member ? 'member' : 'owner'),
    members: { items: team === 'large' ? largeTeam : membersFixture },
    invitations: { items: [] },
    roles: rolesFixture,
    autonomy: { available: false, policies: [] },
    'source-environments': { available: false, items: [] },
    'api-apps': { items: [apiAppFixture], scopes: apiAppScopesFixture },
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.origin,
    );
    const resource = url.pathname.split('/').at(-1) ?? '';
    const method = input instanceof Request ? input.method : init?.method;
    if (
      url.pathname.includes(`/organizations/${organizationId}/`) &&
      (method ?? 'GET') === 'GET' &&
      resource in answers
    )
      return Response.json(answers[resource]);
    if (
      url.pathname.endsWith(`/organizations/${organizationId}/api-apps`) &&
      method === 'POST'
    )
      return Response.json(
        {
          app: { ...apiAppFixture, id: '99999999-9999-4999-8999-999999999999' },
          token: `luma_eu_${'x'.repeat(43)}0a1b2c3d`,
        },
        { status: 201 },
      );

    return original(input, init);
  };

  return () => {
    globalThis.fetch = original;
  };
}

function Preview({
  section = 'workspace',
  state = 'ready',
  member = false,
  roleId,
  team = 'small',
  solo = false,
  morningBrief = false,
}: {
  section?: SettingsSection;
  state?: 'ready' | 'loading' | 'error' | 'mail-unavailable' | 'mail-paused';
  member?: boolean;
  roleId?: string;
  team?: 'small' | 'large';
  solo?: boolean;
  morningBrief?: boolean;
}) {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const context = contextFixture(organizationId, member ? 'member' : 'owner');
    value.setQueryData(contextOptions(organizationId).queryKey, context);
    value.setQueryData(sessionOptions().queryKey, null);
    value.setQueryData(rolesOptions(organizationId).queryKey, rolesFixture);
    value.setQueryData(
      membersOptions(organizationId).queryKey,
      team === 'large' ? largeTeam : membersFixture,
    );
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
                  : {
                      ...data,
                      morningBriefAvailable: morningBrief,
                      workspace: {
                        ...data.workspace,
                        activeMemberCount: solo ? 1 : 2,
                      },
                      deliveryAvailable: state !== 'mail-unavailable',
                      emailPaused: state === 'mail-paused' ? 'bounced' : null,
                    }
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
  beforeEach: ({ args }) => mockTeam(args),
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

export const SoloApprovals: Story = {
  args: { section: 'approvals', solo: true },
};

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

export const DeliveryPaused: Story = {
  args: { section: 'notifications', state: 'mail-paused' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByText('Email to you is paused')).toBeVisible(),
    );
  },
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

export const LargeTeam: Story = {
  args: { section: 'team', team: 'large' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pages = canvas.getByRole('navigation', { name: 'Team pages' });
    await expect(pages).toHaveTextContent('1–25 of 60 people');
    await expect(pages).toHaveTextContent('Page 1 of 3');
    await userEvent.click(within(pages).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(pages).toHaveTextContent('26–50 of 60 people'));
    // Rows fade in, so check which people the page holds rather than their visibility.
    await expect(canvas.getByText('Teammate 22')).toBeInTheDocument();
    await expect(canvas.queryByText('Teammate 21')).toBeNull();

    await userEvent.type(
      canvas.getByRole('textbox', { name: 'Search team' }),
      'Teammate 5',
    );
    await waitFor(() => expect(pages).toHaveTextContent('1–8 of 8 people'));
    await expect(
      within(pages).getByRole('button', { name: 'Next' }),
    ).toBeDisabled();
  },
};

export const MorningBrief: Story = {
  args: { section: 'notifications', member: true, morningBrief: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const time = canvas.getByLabelText('Delivery time (Europe/Berlin)');
    await expect(time).toBeDisabled();
    await userEvent.click(
      canvas.getByRole('switch', { name: 'Daily morning brief' }),
    );
    await expect(time).toBeEnabled();
    await expect(time).toHaveValue('08:00');
    await expect(
      canvas.getByRole('button', { name: 'Save changes' }),
    ).toBeEnabled();
    await userEvent.click(
      canvas.getByRole('switch', { name: 'Daily morning brief' }),
    );
    await expect(time).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: 'Save changes' }),
    ).toBeDisabled();
  },
};

export const ApiApps: Story = {
  args: { section: 'api-apps' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Weekly sales report'),
    ).toBeInTheDocument();
    await expect(canvas.getByText('Token ends in 3f9a')).toBeInTheDocument();
    await expect(
      canvas.getByText('1,480 customer records read in the last 30 days'),
    ).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole('button', { name: 'Create API app' }),
    );
    const dialog = within(await within(document.body).findByRole('dialog'));
    await expect(dialog.getByText('Personal data')).toBeVisible();
    const create = dialog.getByRole('button', { name: 'Create API app' });
    await expect(create).toBeDisabled();
    await userEvent.type(dialog.getByLabelText('Name'), 'Stock export');
    await userEvent.click(
      dialog.getByRole('checkbox', { name: /View inventory/ }),
    );
    await expect(create).toBeEnabled();
    await userEvent.click(create);
    const issued = within(
      await within(document.body).findByRole('dialog', {
        name: 'Copy your token',
      }),
    );
    await expect(issued.getByLabelText('API token')).toHaveTextContent(
      /^luma_eu_/,
    );
  },
};
