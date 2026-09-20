export type Role = 'owner' | 'admin' | 'member';

export type DataRegion = 'EU' | 'US' | 'APAC';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  dataRegion: DataRegion;
  status: 'active' | 'suspended' | 'closed';
}

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
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
    role: Role;
  }>;
  readonly requestId: string;
}

export class IdentityError extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 404 | 409 | 422 | 503,
    readonly code:
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
      role: member.role,
    }),
    requestId,
  });
}

/** Rejects unresolved contexts and tenant mismatches with a not-found error. */
export function requireTenant(context: TenantContext, tenantId: string): void {
  if (context[resolvedContext] !== true || context.tenantId !== tenantId)
    throw new IdentityError(404, 'NOT_FOUND', 'Resource not found');
}

/**
 * Requires a resolved tenant context and one of the supplied organization roles; otherwise
 * throws an identity error.
 */
export function requireRole(
  context: TenantContext,
  roles: readonly Role[],
): void {
  requireTenant(context, context.tenantId);
  if (!roles.includes(context.actor.role))
    throw new IdentityError(403, 'FORBIDDEN', 'Insufficient organization role');
}
