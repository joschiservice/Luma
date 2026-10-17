import { ServiceError } from '@luma/platform';

import type { AppPermission, Permission } from './permissions.js';
import type { BuiltInRoleKey, RoleReference } from './roles.js';
import { builtInReference, PermissionSet } from './roles.js';

/** A concrete supported data-residency jurisdiction. */
export type DataRegion = 'EU' | 'AU' | 'US';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  dataRegion: DataRegion;
  status: 'active' | 'suspended' | 'closed';
}

/** A suspended membership keeps its role but resolves no tenant context until reactivated. */
export type MembershipStatus = 'active' | 'suspended';

export interface Membership {
  name?: string;
  email?: string;
  id: string;
  organizationId: string;
  userId: string;
  role: RoleReference;
  /** Stored memberships always carry it; trusted fixtures may omit it for an active member. */
  status?: MembershipStatus;
  /** Whether Luma staff disabled the person's account; then no workspace accepts them. */
  accountDisabled?: boolean;
  /** Effective grants of the role; resolved with the membership. */
  permissions: PermissionSet;
}

export interface SessionIdentity {
  userId: string;
  sessionId: string;
}
const resolvedContext: unique symbol = Symbol('resolvedTenantContext');

/** How Luma staff were allowed to open a support view: workspace consent or emergency access. */
export type SupportViewMode = 'consent' | 'emergency';

/** A read-only support view: Luma staff see the workspace as one member. */
export interface SupportView {
  id: string;
  mode: SupportViewMode;
  expiresAt: string;
}

export interface TenantContext {
  readonly [resolvedContext]: true;
  readonly tenantId: string;
  readonly dataRegion: DataRegion;
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
  /**
   * Present when Luma staff view the workspace as the actor. The actor's permissions decide what
   * they see; every change is refused.
   */
  readonly supportView?: Readonly<SupportView>;
}

/**
 * The former name of `ServiceError`, kept so existing throws and `instanceof` checks behave the
 * same. Both names refer to one class: an error thrown as either matches checks for both and gets
 * the same HTTP response. New code throws `ServiceError` or its helpers from `@luma/platform`.
 */
export const IdentityError = ServiceError;

export type IdentityError = ServiceError;

/**
 * Rejects a member's suspended or closed workspace. Callers see the same not-found response as
 * for a missing workspace; background work treats it as paused and checks again later.
 */
export class WorkspaceInactiveError extends IdentityError {
  constructor() {
    super(404, 'NOT_FOUND', 'Organization not found');
  }
}

/**
 * Rejects a suspended membership. The member knows the workspace exists, so callers see 403
 * with the `ACCESS_SUSPENDED` code.
 * Background work acting as the member pauses and checks again later instead of failing.
 */
export class MembershipSuspendedError extends IdentityError {
  constructor(
    message = 'Your access to this workspace is suspended. Contact a workspace owner or Luma support.',
  ) {
    super(403, 'ACCESS_SUSPENDED', message);
  }
}

/**
 * Rejects a person whose account Luma staff disabled, in every workspace. It is a
 * `MembershipSuspendedError`, so background work acting as them pauses the same way and continues
 * after the account is enabled. Requests normally fail earlier: the account has no sessions.
 */
export class AccountDisabledError extends MembershipSuspendedError {
  constructor() {
    super(
      'This account is disabled. Contact your workspace owner or Luma support.',
    );
  }
}

/**
 * Rejects background work acting as a person whose account was erased. It is a
 * `MembershipSuspendedError`, so the work pauses and shows that it needs a new owner; it never
 * continues as that person.
 */
export class AccountErasedError extends MembershipSuspendedError {
  constructor() {
    super(
      'This account was deleted. Another member needs to take over its work.',
    );
  }
}

/**
 * Reports whether background work should pause and check again later instead of failing:
 * the workspace is inactive, or the member it acts as is suspended or their account disabled.
 */
export function pausesBackgroundWork(error: unknown): boolean {
  return (
    error instanceof WorkspaceInactiveError ||
    error instanceof MembershipSuspendedError
  );
}

/**
 * Throws `AccountDisabledError` when the person's account is disabled, and
 * `MembershipSuspendedError` when the membership is suspended.
 */
export function requireActiveMembership(member: Membership): void {
  if (member.accountDisabled) throw new AccountDisabledError();
  if (member.status === 'suspended') throw new MembershipSuspendedError();
}

/**
 * Refuses a change in a support view. The guard already refuses routes that change data; services
 * that execute actions, approve or call models check again.
 */
export class ReadOnlyAccessError extends IdentityError {
  constructor() {
    super(
      403,
      'READ_ONLY',
      'Luma support is viewing this workspace read-only. Nothing was changed.',
    );
  }
}

/** Throws `ReadOnlyAccessError` when the context is a support view. */
export function requireChangesAllowed(context: TenantContext): void {
  if (context.supportView) throw new ReadOnlyAccessError();
}

/**
 * Creates an immutable context for a matching, active membership in an active organization in the serving cell;
 * rejects inaccessible or unsupported organizations. A suspended or closed organization
 * raises `WorkspaceInactiveError`, a suspended membership `MembershipSuspendedError` and a
 * disabled account `AccountDisabledError`.
 * `supportView` marks a read-only context for Luma staff viewing the workspace as the member.
 */
export function makeTenantContext(
  session: SessionIdentity,
  organization: Organization,
  member: Membership,
  requestId: string,
  supportView?: SupportView,
  cellRegion: DataRegion = organization.dataRegion,
): TenantContext {
  if (
    member.userId !== session.userId ||
    member.organizationId !== organization.id
  )
    throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');
  if (organization.status !== 'active') throw new WorkspaceInactiveError();
  requireActiveMembership(member);
  if (organization.dataRegion !== cellRegion)
    throw new IdentityError(
      503,
      'REGION_UNAVAILABLE',
      'Organization region is unavailable',
    );

  return Object.freeze({
    [resolvedContext]: true as const,
    tenantId: organization.id,
    dataRegion: organization.dataRegion,
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
    ...(supportView ? { supportView: Object.freeze({ ...supportView }) } : {}),
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
