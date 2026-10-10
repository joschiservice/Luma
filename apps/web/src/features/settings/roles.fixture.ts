import type { Membership, RolesSnapshot } from '@luma/api-contract';

import { memberPermissions } from '../identity/context.fixture';

const groups: RolesSnapshot['groups'] = [
  {
    id: 'workspace',
    label: 'Workspace',
    description: 'Shared workspace details and approval policy.',
    app: null,
  },
  {
    id: 'access',
    label: 'Team and access',
    description: 'Who belongs to the workspace and what each role can do.',
    app: null,
  },
  {
    id: 'records',
    label: 'Commerce records',
    description: 'Imported orders, stock, products, customers and returns.',
    app: null,
  },
  {
    id: 'issues',
    label: 'Issues and decisions',
    description:
      'Operational issues, their evidence and the decisions they need.',
    app: null,
  },
  {
    id: 'procurement',
    label: 'Procurement',
    description: 'Suppliers, purchase orders and replenishment.',
    app: null,
  },
  {
    id: 'app:jtl',
    label: 'JTL',
    description: 'Permissions for JTL’s own features.',
    app: { id: 'jtl', name: 'JTL', available: true },
  },
];

const permission = (
  key: string,
  group: string,
  label: string,
  description: string,
  consequential = false,
  introduced: string | null = '2026-10-06',
) => ({ key, group, label, description, consequential, introduced });

/** A representative permission catalog for stories and tests. */
export const rolesFixture: RolesSnapshot = {
  groups,
  permissions: [
    permission(
      'workspace.settings.manage',
      'workspace',
      'Edit workspace settings',
      'Change the workspace name and display timezone.',
    ),
    permission(
      'workspace.approval_policy.manage',
      'workspace',
      'Manage approval rules',
      'Decide whether every permitted change needs independent approval.',
      true,
    ),
    permission(
      'members.manage',
      'access',
      'Manage team members',
      'Invite people, change their role and remove their access.',
      true,
    ),
    permission(
      'roles.manage',
      'access',
      'Manage roles',
      'Create, edit and archive custom roles.',
      true,
    ),
    permission(
      'orders.read',
      'records',
      'View orders',
      'See orders, their lines, payments and provider links.',
    ),
    permission(
      'inventory.read',
      'records',
      'View inventory',
      'See stock positions, locations and stock history.',
    ),
    permission(
      'customers.read',
      'records',
      'View customers',
      'See customer profiles, including names, email addresses and postal addresses.',
      true,
    ),
    permission(
      'issues.read',
      'issues',
      'View issues',
      'See issues, their evidence, diagnoses and proposed actions.',
    ),
    permission(
      'decisions.respond',
      'issues',
      'Approve or reject changes',
      'Respond to approval requests from other people.',
      true,
    ),
    permission(
      'procurement.read',
      'procurement',
      'View procurement',
      'See suppliers, purchase orders, commitments and replenishment.',
    ),
    permission(
      'procurement.manage',
      'procurement',
      'Manage procurement',
      'Edit suppliers and purchase orders and configure replenishment.',
      true,
    ),
    permission(
      'jtl:purchase_orders.submit',
      'app:jtl',
      'Send purchase orders to JTL',
      'Propose, approve and send purchase orders to JTL.',
      true,
      null,
    ),
  ],
  roles: [
    {
      id: 'owner',
      key: 'owner',
      name: 'Owner',
      description:
        'Full access, including granting and removing ownership. Every workspace keeps at least one owner.',
      builtIn: true,
      revision: 1,
      archived: false,
      permissions: [],
      allAppPermissions: true,
      memberCount: 1,
      pendingInvitations: 0,
      updatedAt: null,
    },
    {
      id: 'admin',
      key: 'admin',
      name: 'Admin',
      description:
        'Runs the workspace: settings, team, connections, workflows, and every change. Can’t change owners.',
      builtIn: true,
      revision: 1,
      archived: false,
      permissions: [],
      allAppPermissions: true,
      memberCount: 2,
      pendingInvitations: 0,
      updatedAt: null,
    },
    {
      id: 'member',
      key: 'member',
      name: 'Member',
      description:
        'Sees operations, records, and workflows, takes decisions, and asks Luma. Can’t change data or settings.',
      builtIn: true,
      revision: 1,
      archived: false,
      permissions: memberPermissions,
      allAppPermissions: false,
      memberCount: 6,
      pendingInvitations: 1,
      updatedAt: null,
    },
    {
      id: '77777777-7777-4777-8777-777777777777',
      key: 'custom',
      name: 'Buyer',
      description: 'Works with suppliers and purchase orders.',
      builtIn: false,
      revision: 3,
      archived: false,
      permissions: [
        'inventory.read',
        'orders.read',
        'procurement.manage',
        'procurement.read',
      ],
      allAppPermissions: false,
      memberCount: 2,
      pendingInvitations: 1,
      updatedAt: '2026-10-06T09:30:00.000Z',
    },
    {
      id: '88888888-8888-4888-8888-888888888888',
      key: 'custom',
      name: 'Seasonal support',
      description: 'Temporary help during peak season.',
      builtIn: false,
      revision: 4,
      archived: true,
      permissions: ['orders.read'],
      allAppPermissions: false,
      memberCount: 0,
      pendingInvitations: 0,
      updatedAt: '2026-10-02T09:30:00.000Z',
    },
  ],
};

const member = (
  id: string,
  name: string,
  email: string,
  roleId: string,
): Membership => {
  const role = rolesFixture.roles.find((item) => item.id === roleId)!;

  return {
    id,
    organizationId: '11111111-1111-4111-8111-111111111111',
    userId: id,
    name,
    email,
    role: {
      id: role.id,
      key: role.key,
      name: role.name,
      builtIn: role.builtIn,
      revision: role.revision,
    },
    status: 'active',
  };
};

/** Team members with built-in and custom roles, for stories and tests. */
export const membersFixture: Membership[] = [
  member(
    '22222222-2222-4222-8222-222222222222',
    'Mira Hoffmann',
    'mira@northstar.example',
    'owner',
  ),
  member(
    '33333333-3333-4333-8333-333333333333',
    'Jonas Weber',
    'jonas@northstar.example',
    '77777777-7777-4777-8777-777777777777',
  ),
  member(
    '44444444-4444-4444-8444-444444444444',
    'Lea Braun',
    'lea@northstar.example',
    '77777777-7777-4777-8777-777777777777',
  ),
  member(
    '55555555-5555-4555-8555-555555555555',
    'Tom Fischer',
    'tom@northstar.example',
    'member',
  ),
];
