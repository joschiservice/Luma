import type { TenantContextResponse } from '@luma/api-contract';

const managing = [
  'workspace.settings.manage',
  'workspace.approval_policy.manage',
  'members.manage',
  'roles.manage',
  'issues.manage',
  'decisions.assign',
  'decisions.respond',
  'actions.propose',
  'actions.execute',
  'workflows.author',
  'workflows.publish',
  'workflows.triggers.manage',
  'playbooks.activate',
  'procurement.manage',
  'connections.manage',
  'sync.manage',
  'apps.manage',
  'activity.read_restricted',
];

/** Permissions of the built-in Member role, for stories and tests. */
export const memberPermissions = [
  'orders.read',
  'fulfillment.read',
  'inventory.read',
  'products.read',
  'customers.read',
  'returns.read',
  'insights.read',
  'issues.read',
  'decisions.self_assign',
  'workflows.read',
  'procurement.read',
  'assistant.use',
  'activity.read',
];

/** Builds a tenant context response for a built-in or custom role, for stories and tests. */
export function contextFixture(
  organizationId: string,
  role: 'owner' | 'admin' | 'member' | { name: string; permissions: string[] },
  actorId = '22222222-2222-4222-8222-222222222222',
): TenantContextResponse {
  const builtIn = typeof role === 'string';

  return {
    tenantId: organizationId,
    dataRegion: 'AU',
    requestId: 'fixture',
    actor: {
      type: 'user',
      id: actorId,
      initiatingUserId: actorId,
      sessionId: actorId,
      membershipId: actorId,
      role: builtIn
        ? {
            id: role,
            key: role,
            name: role[0]!.toUpperCase() + role.slice(1),
            builtIn: true,
            revision: 1,
          }
        : {
            id: '99999999-9999-4999-8999-999999999999',
            key: 'custom',
            name: role.name,
            builtIn: false,
            revision: 1,
          },
    },
    permissions: builtIn
      ? role === 'member'
        ? memberPermissions
        : [...memberPermissions, ...managing]
      : role.permissions,
    allAppPermissions: builtIn && role !== 'member',
  };
}
