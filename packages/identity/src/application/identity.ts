import type {
  Membership,
  Organization,
  SessionIdentity,
  TenantContext,
} from '../domain/context.js';
import {
  IdentityError,
  isOwner,
  makeTenantContext,
  requirePermission,
  requireTenant,
} from '../domain/context.js';
import type { PermissionSet, RoleReference } from '../domain/roles.js';

export type Credentials = Readonly<Record<string, string>>;

export interface IdentityTransaction {
  /** Reads a membership command receipt within the locked workspace. */
  memberCommand(
    organizationId: string,
    id: string,
  ): Promise<{
    actorId: string;
    request: string;
    result: MemberDto | null;
  } | null>;
  /** Persists the membership outcome atomically with its mutation. */
  saveMemberCommand(
    organizationId: string,
    id: string,
    actorId: string,
    request: string,
    result: MemberDto | null,
  ): Promise<void>;
  /** Records bounded access evidence in the membership transaction. */
  auditMember(
    organizationId: string,
    actorId: string,
    action: string,
    before: AuditedMember | null,
    after: AuditedMember | null,
  ): Promise<void>;
  /** Reads an assignable role in the selected tenant, including archived custom roles. */
  findRole(
    organizationId: string,
    roleId: string,
  ): Promise<{
    reference: RoleReference;
    permissions: PermissionSet;
    archived: boolean;
  } | null>;
  listOrganizations(): Promise<Organization[]>;
  findMembership(organizationId: string): Promise<Membership | null>;
  findOrganization(organizationId: string): Promise<Organization | null>;
  createOrganization(input: {
    name: string;
    slug: string;
  }): Promise<Organization>;
  selectTenant(organizationId: string): Promise<void>;
  lockOrganization(organizationId: string): Promise<void>;
  listMembers(organizationId: string): Promise<Membership[]>;
  addMember(
    organizationId: string,
    userId: string,
    roleId: string,
  ): Promise<Membership>;
  updateMember(
    organizationId: string,
    memberId: string,
    roleId: string,
  ): Promise<Membership>;
  removeMember(organizationId: string, memberId: string): Promise<void>;
}

/** A membership as returned to API callers, without its permission set. */
export interface MemberDto {
  id: string;
  organizationId: string;
  userId: string;
  name?: string | undefined;
  email?: string | undefined;
  role: RoleReference;
}

/** The bounded membership values recorded in access events. */
interface AuditedMember {
  id: string;
  userId: string;
  roleId: string;
  roleName: string;
}

/** Strips grants from a membership for API responses and command receipts. */
export function memberDto(member: Membership): MemberDto {
  return {
    id: member.id,
    organizationId: member.organizationId,
    userId: member.userId,
    ...(member.name !== undefined ? { name: member.name } : {}),
    ...(member.email !== undefined ? { email: member.email } : {}),
    role: member.role,
  };
}

export interface IdentityRepository {
  getSession(credentials: Credentials): Promise<SessionIdentity | null>;
  withUser<T>(
    userId: string,
    operation: (tx: IdentityTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * Creates session and tenant resolution plus organization and membership commands backed by
 * the supplied repository.
 */
export function createIdentityService(repository: IdentityRepository) {
  async function authenticate(
    credentials: Credentials,
  ): Promise<SessionIdentity> {
    const session = await repository.getSession(credentials);
    if (!session)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

    return session;
  }

  async function resolve(
    tx: IdentityTransaction,
    session: SessionIdentity,
    organizationId: string,
    requestId: string,
  ) {
    const member = await tx.findMembership(organizationId);
    const organization = member && (await tx.findOrganization(organizationId));
    if (!member || !organization)
      throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');

    return makeTenantContext(session, organization, member, requestId);
  }

  async function withTenant<T>(
    context: TenantContext,
    operation: (tx: IdentityTransaction) => Promise<T>,
  ) {
    requireTenant(context, context.tenantId);

    return repository.withUser(context.actor.id, async (tx) => {
      await tx.selectTenant(context.tenantId);

      return operation(tx);
    });
  }

  return {
    authenticate,
    /** Reauthorize the initiating user of a trusted durable workflow. */
    async resolveWorkflowContext(
      userId: string,
      tenantId: string,
      requestId: string,
    ) {
      return repository.withUser(userId, (tx) =>
        resolve(
          tx,
          { userId, sessionId: `workflow:${requestId}` },
          tenantId,
          requestId,
        ),
      );
    },
    async refreshContext(context: TenantContext) {
      requireTenant(context, context.tenantId);

      return repository.withUser(context.actor.id, (tx) =>
        resolve(
          tx,
          { userId: context.actor.id, sessionId: context.actor.sessionId },
          context.tenantId,
          context.requestId,
        ),
      );
    },
    async listOrganizations(credentials: Credentials) {
      const session = await authenticate(credentials);

      return repository.withUser(session.userId, (tx) =>
        tx.listOrganizations(),
      );
    },
    async createOrganization(
      credentials: Credentials,
      input: {
        name: string;
        slug: string;
        dataRegion?: 'EU' | 'US' | 'APAC' | undefined;
      },
    ) {
      const session = await authenticate(credentials);
      if (input.dataRegion && input.dataRegion !== 'EU')
        throw new IdentityError(
          422,
          'REGION_UNAVAILABLE',
          'Requested region is unavailable',
        );

      return repository.withUser(session.userId, (tx) =>
        tx.createOrganization({ name: input.name, slug: input.slug }),
      );
    },
    async resolveTenant(
      credentials: Credentials,
      organizationId: string,
      requestId: string,
    ) {
      const session = await authenticate(credentials);

      return repository.withUser(session.userId, (tx) =>
        resolve(tx, session, organizationId, requestId),
      );
    },
    /** Lists members with their roles; any member may read the team. */
    listMembers(context: TenantContext) {
      return withTenant(context, async (tx) =>
        (await tx.listMembers(context.tenantId)).map(memberDto),
      );
    },
    /**
     * Adds, reassigns or removes a member under the organization lock. Requires
     * `members.manage`; only owners change ownership, the last owner stays, and nobody else can
     * assign a role or change a member whose permissions exceed their own.
     */
    changeMember(
      initialContext: TenantContext,
      command: { commandId?: string } & (
        | { action: 'add'; userId: string; roleId: string }
        | { action: 'update'; memberId: string; roleId: string }
        | { action: 'remove'; memberId: string }
      ),
    ) {
      const { tenantId: organizationId, requestId } = initialContext;

      return withTenant(initialContext, async (tx) => {
        await tx.lockOrganization(organizationId);
        // Recheck membership after taking the lock so concurrent revocations win.
        const session = {
          userId: initialContext.actor.id,
          sessionId: initialContext.actor.sessionId,
        };
        const context = await resolve(tx, session, organizationId, requestId);
        requirePermission(context, 'members.manage');
        const request = JSON.stringify(command);
        if (command.commandId) {
          const previous = await tx.memberCommand(
            organizationId,
            command.commandId,
          );
          if (previous) {
            if (
              previous.actorId !== context.actor.id ||
              previous.request !== request
            )
              throw new IdentityError(
                409,
                'CONFLICT',
                'This command ID was already used for another request.',
              );

            return previous.result;
          }
        }
        const members = await tx.listMembers(organizationId);
        const target =
          command.action === 'add'
            ? null
            : members.find((m) => m.id === command.memberId);
        if (command.action !== 'add' && !target)
          throw new IdentityError(404, 'NOT_FOUND', 'Member not found');
        const next =
          command.action === 'remove'
            ? null
            : await tx.findRole(organizationId, command.roleId);
        if (command.action !== 'remove' && (!next || next.archived))
          throw new IdentityError(
            409,
            'CONFLICT',
            'This role is no longer available. Refresh and choose another role.',
          );
        if (
          (target?.role.key === 'owner' || next?.reference.key === 'owner') &&
          !isOwner(context)
        )
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'Only owners can grant or remove ownership.',
          );
        if (
          !isOwner(context) &&
          ((target && !context.permissions.covers(target.permissions)) ||
            (next && !context.permissions.covers(next.permissions)))
        )
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'You can only assign roles, and change members, whose permissions you hold yourself.',
          );
        if (
          target?.role.key === 'owner' &&
          next?.reference.key !== 'owner' &&
          members.filter((m) => m.role.key === 'owner').length === 1
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'An organization must have an owner',
          );
        let result: Membership | null = null;
        if (command.action === 'add')
          result = await tx.addMember(
            organizationId,
            command.userId,
            command.roleId,
          );
        else if (command.action === 'update')
          result = await tx.updateMember(
            organizationId,
            command.memberId,
            command.roleId,
          );
        else await tx.removeMember(organizationId, command.memberId);
        const bounded = (member: Membership | null | undefined) =>
          member
            ? {
                id: member.id,
                userId: member.userId,
                roleId: member.role.id,
                roleName: member.role.name,
              }
            : null;
        await tx.auditMember(
          organizationId,
          context.actor.id,
          command.action,
          bounded(target),
          bounded(result),
        );
        const dto = result ? memberDto(result) : null;
        if (command.commandId)
          await tx.saveMemberCommand(
            organizationId,
            command.commandId,
            context.actor.id,
            request,
            dto,
          );

        return dto;
      });
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
