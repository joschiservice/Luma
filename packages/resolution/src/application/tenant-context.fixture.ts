import type { Membership, Permission } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';

/**
 * Builds a resolved tenant context. Defaults to an owner in a fixed workspace; pass another
 * built-in role, or `permissions` for a custom role holding exactly those grants.
 */
export function testContext({
  role = 'owner',
  permissions,
  userId = 'owner',
  tenantId = '00000000-0000-4000-8000-000000000001',
}: {
  role?: 'owner' | 'admin' | 'member';
  permissions?: readonly Permission[];
  userId?: string;
  tenantId?: string;
} = {}) {
  const member = { id: 'membership', organizationId: tenantId, userId };
  const membership: Membership = permissions
    ? {
        ...member,
        role: {
          id: 'custom-role',
          key: 'custom',
          name: 'Custom',
          builtIn: false,
          revision: 1,
        },
        permissions: new PermissionSet(permissions),
      }
    : builtInMembership(member, role);

  return makeTenantContext(
    { userId, sessionId: 'session' },
    {
      id: tenantId,
      name: 'Workspace',
      slug: 'workspace',
      status: 'active',
      dataRegion: 'AU',
    },
    membership,
    'request',
  );
}
