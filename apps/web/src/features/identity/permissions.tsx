import { buttonVariants } from '@luma/ui/components/primitives/button';
import { Empty } from '@luma/ui/components/primitives/empty';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LockKeyhole } from 'lucide-react';
import { useMemo } from 'react';

import { rolesOptions } from '../settings/roles-data';
import { contextOptions } from './data';

/**
 * Reports whether a role is the built-in Owner role. Ownership is a role rather than a
 * permission: only owners grant or remove it, and every workspace keeps one.
 */
export function isOwnerRole(role: { key: string } | null | undefined) {
  return role?.key === 'owner';
}

/** Reports whether a granted set allows a core or app permission. */
export function grants(
  permissions: readonly string[],
  allAppPermissions: boolean,
  permission: string,
) {
  return (
    permissions.includes(permission) ||
    (allAppPermissions && permission.includes(':'))
  );
}

/**
 * Reads what the signed-in person may do in a workspace from their current tenant context.
 * Everything is denied until the context loads; the server enforces every permission again.
 */
export function usePermissions(organizationId: string) {
  const context = useQuery(contextOptions(organizationId));

  return useMemo(() => {
    const data = context.data;
    const can = (permission: string) =>
      !!data && grants(data.permissions, data.allAppPermissions, permission);
    const owner = isOwnerRole(data?.actor.role);

    return {
      ready: !!data,
      role: data?.actor.role,
      owner,
      can,
      /**
       * Reports whether the person may grant everything a role grants. Owners may grant any
       * role; others only roles within their own permissions.
       */
      covers: (role: {
        permissions: readonly string[];
        allAppPermissions: boolean;
      }) =>
        owner ||
        (!!data &&
          (!role.allAppPermissions || data.allAppPermissions) &&
          role.permissions.every(can)),
    };
  }, [context.data]);
}

/** Reports whether the signed-in person holds one permission in a workspace. */
export function useCan(organizationId: string, permission: string) {
  return usePermissions(organizationId).can(permission);
}

/** Looks up a permission's people-facing label, falling back to its key. */
export function usePermissionLabel(organizationId: string, permission: string) {
  const roles = useQuery({ ...rolesOptions(organizationId), retry: false });

  return (
    roles.data?.permissions.find((item) => item.key === permission)?.label ??
    permission
  );
}

/**
 * Explains that the person's role does not include a permission, instead of showing an empty or
 * partial page. Links to their role so they can see what it allows.
 */
export function NoAccess({
  organizationId,
  area,
  permission,
}: {
  organizationId: string;
  /** What the page shows, such as "orders". */
  area: string;
  permission: string;
}) {
  const { role } = usePermissions(organizationId);
  const label = usePermissionLabel(organizationId, permission);

  return (
    <Empty className="no-access" aria-labelledby="no-access-title">
      <LockKeyhole aria-hidden="true" />
      <h2 id="no-access-title">You don’t have access to {area}</h2>
      <p>
        {role ? `Your ${role.name} role` : 'Your role'} doesn’t include{' '}
        <strong>{label}</strong>. Ask a workspace admin if you need it.
      </p>
      <Link
        className={buttonVariants({ variant: 'outline' })}
        to="/app/$organizationId/settings/$section"
        params={{ organizationId, section: 'roles' }}
        search={role ? { role: role.id } : {}}
      >
        See what your role allows
      </Link>
    </Empty>
  );
}

/** A short explanation shown beside an action the person's role does not allow. */
export function MissingPermission({
  organizationId,
  permission,
  id,
}: {
  organizationId: string;
  permission: string;
  id?: string;
}) {
  const label = usePermissionLabel(organizationId, permission);

  return (
    <span className="missing-permission" id={id}>
      <LockKeyhole size={12} aria-hidden="true" /> Requires {label}
    </span>
  );
}
