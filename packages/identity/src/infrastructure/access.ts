import type { Membership } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import type { RoleReference } from '../domain/roles.js';
import {
  builtInReference,
  isBuiltInRole,
  PermissionSet,
} from '../domain/roles.js';

/**
 * Selects memberships with their role and, for custom roles, granted permissions in one
 * statement. Callers append the `WHERE` clause on `m`.
 */
export const membershipSelect = `SELECT m.id,m.tenant_id AS "organizationId",m.user_id AS "userId",m.role,m.status,
  m.custom_role_id AS "customRoleId",r.name AS "roleName",r.revision AS "roleRevision",
  CASE WHEN m.custom_role_id IS NULL THEN NULL ELSE ARRAY(SELECT p.permission FROM workspace_role_permissions p
    WHERE p.tenant_id=m.tenant_id AND p.role_id=m.custom_role_id ORDER BY p.permission) END AS permissions
  FROM memberships m LEFT JOIN workspace_roles r ON r.tenant_id=m.tenant_id AND r.id=m.custom_role_id`;

export type MembershipRow = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  status: string;
  customRoleId: string | null;
  roleName: string | null;
  roleRevision: number | null;
  permissions: string[] | null;
};

/** Maps a stored role reference to its public form; unknown roles grant nothing and fail closed. */
export function roleFromRow(row: {
  role: string;
  customRoleId: string | null;
  roleName: string | null;
  roleRevision: number | null;
}): RoleReference {
  if (isBuiltInRole(row.role) && !row.customRoleId)
    return builtInReference(row.role);
  if (row.role === 'custom' && row.customRoleId && row.roleName)
    return {
      id: row.customRoleId,
      key: 'custom',
      name: row.roleName,
      builtIn: false,
      revision: row.roleRevision ?? 1,
    };
  throw new IdentityError(403, 'FORBIDDEN', 'Unknown organization role');
}

/** Maps a membership row with its role grants to a membership. */
export function membershipFromRow(row: MembershipRow): Membership {
  const role = roleFromRow(row);

  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role,
    // Unknown states fail closed as suspended.
    status: row.status === 'active' ? 'active' : 'suspended',
    permissions: PermissionSet.forRole(role, row.permissions ?? []),
  };
}

/** Splits a role ID into the stored built-in key or custom role reference. */
export function storedRole(roleId: string) {
  return isBuiltInRole(roleId)
    ? { role: roleId, customRoleId: null }
    : { role: 'custom', customRoleId: roleId };
}
