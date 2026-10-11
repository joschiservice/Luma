import type {
  PermissionDefinition,
  RoleHistoryEvent,
  RolesSnapshot,
  WorkspaceRole,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { privateQueryDefaults } from '../../lib/private-query';
import { localizeRoles } from '../identity/permission-text';
import { settingsApi } from './data';

export type { PermissionDefinition, WorkspaceRole };

/**
 * Loads workspace roles with member counts and the grantable permission catalog, with known
 * permissions and built-in roles in the interface language.
 */
export const rolesOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'roles'],
    queryFn: ({ signal }): Promise<RolesSnapshot> =>
      settingsApi.roles.list({ params: { organizationId } }, { signal }),
    select: localizeRoles,
  });

/** Loads a role's recent changes and member assignments; needs permission to manage roles. */
export const roleHistoryOptions = (organizationId: string, roleId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: ['private', 'organization', organizationId, 'roles', roleId],
    queryFn: async ({ signal }): Promise<RoleHistoryEvent[]> =>
      (
        await settingsApi.roles.history(
          { params: { organizationId, roleId } },
          { signal },
        )
      ).items,
  });

/** Splits a proposed permission set into additions and removals against the current set. */
export function permissionChanges(
  before: readonly string[],
  after: readonly string[],
) {
  const previous = new Set(before);
  const next = new Set(after);

  return {
    added: [...next].filter((key) => !previous.has(key)).sort(),
    removed: [...previous].filter((key) => !next.has(key)).sort(),
  };
}

/** Reports whether a catalog permission was added after a custom role last changed. */
export function isNewForRole(
  permission: PermissionDefinition,
  role: Pick<WorkspaceRole, 'builtIn' | 'updatedAt'> | null,
) {
  return (
    !!role &&
    !role.builtIn &&
    !!role.updatedAt &&
    !!permission.introduced &&
    permission.introduced > role.updatedAt.slice(0, 10)
  );
}
