import type { AppPermission, Permission } from './permissions.js';
import type { BuiltInRoleKey, RoleReference } from './roles.js';
import { builtInReference, PermissionSet } from './roles.js';

export type DataRegion = 'EU' | 'US' | 'APAC';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  dataRegion: DataRegion;
  status: 'active' | 'suspended' | 'closed';
}

export interface Membership {
  name?: string;
  email?: string;
  id: string;
  organizationId: string;
  userId: string;
  role: RoleReference;
  /** Effective grants of the role; resolved with the membership. */
  permissions: PermissionSet;
}

export interface SessionIdentity {
  userId: string;
  sessionId: string;
}
const resolvedContext: unique symbol = Symbol('resolvedTenantContext');

export interface TenantContext {
  readonly [resolvedContext]: true;
  readonly tenantId: string;
  readonly dataRegion: 'EU';
  readonly actor: Readonly<{
    type: 'user';
    id: string;
    initiatingUserId: string;
    sessionId: string;
    membershipId: string;
    role: Readonly<RoleReference>;
  }>;
  /** What the actor may do, resolved from the current membership with the context. */
  readonly permissions: PermissionSet;
  readonly requestId: string;
}

export class IdentityError extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 404 | 409 | 422 | 503,
    readonly code:
      | 'VALIDATION_ERROR'
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'REGION_UNAVAILABLE'
      | 'SERVICE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Creates an immutable context for a matching membership in an active EU organization;
 * rejects inaccessible or unsupported organizations.
 */
export function makeTenantContext(
  session: SessionIdentity,
  organization: Organization,
  member: Membership,
  requestId: string,
): TenantContext {
  if (
    member.userId !== session.userId ||
    member.organizationId !== organization.id ||
    organization.status !== 'active'
  )
    throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');
  if (organization.dataRegion !== 'EU')
    throw new IdentityError(
      503,
      'REGION_UNAVAILABLE',
      'Organization region is unavailable',
    );

  return Object.freeze({
    [resolvedContext]: true as const,
    tenantId: organization.id,
    dataRegion: 'EU' as const,
    actor: Object.freeze({
      type: 'user' as const,
      id: session.userId,
      initiatingUserId: session.userId,
      sessionId: session.sessionId,
      membershipId: member.id,
      role: Object.freeze({ ...member.role }),
    }),
    permissions: member.permissions,
    requestId,
  });
}

/**
 * Describes a membership holding a built-in role. Use it for trusted seeds and fixtures; request
 * handling resolves memberships from storage.
 */
export function builtInMembership(
  member: Omit<Membership, 'role' | 'permissions'>,
  key: BuiltInRoleKey,
): Membership {
  const role = builtInReference(key);

  return { ...member, role, permissions: PermissionSet.forRole(role) };
}

/** Rejects unresolved contexts and tenant mismatches with a not-found error. */
export function requireTenant(context: TenantContext, tenantId: string): void {
  if (context[resolvedContext] !== true || context.tenantId !== tenantId)
    throw new IdentityError(404, 'NOT_FOUND', 'Resource not found');
}

/** Reports whether a resolved context grants a core or app permission. */
export function hasPermission(
  context: TenantContext,
  permission: Permission | AppPermission,
): boolean {
  return (
    context[resolvedContext] === true && context.permissions.has(permission)
  );
}

/** Requires a resolved tenant context that grants the permission; otherwise throws 403. */
export function requirePermission(
  context: TenantContext,
  permission: Permission | AppPermission,
): void {
  requireTenant(context, context.tenantId);
  if (!context.permissions.has(permission))
    throw new IdentityError(
      403,
      'FORBIDDEN',
      'Your role does not allow this. Ask a workspace admin for access.',
    );
}

/** Reports whether the actor holds the Owner role, which alone may change ownership. */
export function isOwner(context: TenantContext): boolean {
  return context.actor.role.key === 'owner';
}
