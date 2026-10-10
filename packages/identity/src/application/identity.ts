import type {
  Membership,
  MembershipStatus,
  Organization,
  SessionIdentity,
  SupportView,
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
import type {
  SecurityEvent,
  SecurityEventCursor,
} from '../domain/security-events.js';
import {
  decodeSecurityEventCursor,
  encodeSecurityEventCursor,
} from '../domain/security-events.js';
import { describeUserAgent } from '../domain/sessions.js';
import type { SupportViewCredentials } from './support-view.js';

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
  /** Lists the user's workspaces, including those where their membership is suspended. */
  listOrganizations(): Promise<OrganizationAccess[]>;
  /** Reads the user's own name and email. */
  profile(): Promise<{ name: string; email: string } | null>;
  findMembership(organizationId: string): Promise<Membership | null>;
  findOrganization(organizationId: string): Promise<Organization | null>;
  createOrganization(input: {
    name: string;
    slug: string;
  }): Promise<Organization>;
  selectTenant(organizationId: string): Promise<void>;
  lockOrganization(organizationId: string): Promise<void>;
  listMembers(organizationId: string): Promise<Membership[]>;
  /**
   * Returns which of the given user IDs have a suspended membership in the workspace or a
   * disabled account.
   */
  suspendedMembers(
    organizationId: string,
    userIds: readonly string[],
  ): Promise<string[]>;
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

/** A workspace with the signed-in person's membership status in it. */
export type OrganizationAccess = Organization & {
  membershipStatus: MembershipStatus;
};

/** A membership as returned to API callers, without its permission set. */
export interface MemberDto {
  id: string;
  organizationId: string;
  userId: string;
  name?: string | undefined;
  email?: string | undefined;
  role: RoleReference;
  status: MembershipStatus;
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
    status: member.status ?? 'active',
  };
}

export interface IdentityRepository {
  getSession(credentials: Credentials): Promise<SessionIdentity | null>;
  /** Support view credentials; see ADR-011. */
  supportViews: SupportViewCredentials;
  /** Reads one account's security events, newest first, after an optional position. */
  listSecurityEvents(
    userId: string,
    after: SecurityEventCursor | null,
    limit: number,
  ): Promise<SecurityEvent[]>;
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
    supportView?: SupportView,
  ) {
    const member = await tx.findMembership(organizationId);
    const organization = member && (await tx.findOrganization(organizationId));
    if (!member || !organization)
      throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');

    return makeTenantContext(
      session,
      organization,
      member,
      requestId,
      supportView,
    );
  }

  const supportViewEnded = () =>
    new IdentityError(401, 'UNAUTHENTICATED', 'The Luma support view ended.');

  /** Checks the view a support token names; throws 401 once it has ended. */
  async function activeSupportView(
    token: string,
    organizationId: string | null,
    readPath: string | null,
    requestId: string,
  ) {
    const view = await repository.supportViews.resolve(
      token,
      organizationId,
      readPath,
      requestId,
    );
    if (view.state === 'other')
      throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');
    if (view.state !== 'active') throw supportViewEnded();

    return view;
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
    /** Resolves the actor's current membership again; a support view stays a support view. */
    async refreshContext(context: TenantContext) {
      requireTenant(context, context.tenantId);

      return repository.withUser(context.actor.id, (tx) =>
        resolve(
          tx,
          { userId: context.actor.id, sessionId: context.actor.sessionId },
          context.tenantId,
          context.requestId,
          context.supportView,
        ),
      );
    },
    /** Reports whether the credentials carry a support view token, valid or not. */
    hasSupportView(credentials: Credentials) {
      return repository.supportViews.token(credentials) !== null;
    },
    /**
     * Describes the support view the credentials name, for the banner. Inactive when there is
     * none or it ended; ending is recorded by the check itself.
     */
    async supportView(credentials: Credentials, requestId: string) {
      const token = repository.supportViews.token(credentials);
      const view = token
        ? await repository.supportViews.resolve(token, null, null, requestId)
        : null;
      if (!view || view.state !== 'active')
        return {
          active: false as const,
          endReason: view && view.state === 'ended' ? view.reason : null,
        };
      const details = await repository.withUser(view.userId, async (tx) => ({
        organization: await tx.findOrganization(view.tenantId),
        profile: await tx.profile(),
      }));
      if (!details.organization || !details.profile)
        return { active: false as const, endReason: null };

      return {
        active: true as const,
        id: view.id,
        mode: view.mode,
        expiresAt: new Date(view.expiresAt).toISOString(),
        workspace: {
          id: details.organization.id,
          name: details.organization.name,
        },
        member: { id: view.userId, ...details.profile },
      };
    },
    /**
     * Exchanges a single-use handoff from the staff console for a support view token. Throws 404
     * when the link was used, expired or the view can no longer start.
     */
    async redeemSupportView(handoff: string, requestId: string) {
      const view = await repository.supportViews.redeem(handoff, requestId);
      if (!view)
        throw new IdentityError(
          404,
          'NOT_FOUND',
          'This support link was already used or has expired. Start the view again from the staff console.',
        );

      return {
        workspaceId: view.tenantId,
        cookie: repository.supportViews.cookie(view.token),
      };
    },
    /** Ends the support view the credentials name and returns the cookie that clears it. */
    async endSupportView(credentials: Credentials, requestId: string) {
      const token = repository.supportViews.token(credentials);
      if (token) await repository.supportViews.end(token, requestId);

      return repository.supportViews.cookie(null);
    },
    /** Records the end of open support views that are no longer valid. */
    sweepSupportViews: (requestId: string) =>
      repository.supportViews.sweep(requestId),
    /**
     * Lists the signed-in person's own security events, 20 per page, newest first. The account
     * comes from the session, never from the caller. Rejects malformed cursors with 422.
     */
    async listSecurityEvents(credentials: Credentials, cursor?: string) {
      const session = await authenticate(credentials);
      const after = cursor ? decodeSecurityEventCursor(cursor) : null;
      if (cursor && !after)
        throw new IdentityError(
          422,
          'VALIDATION_ERROR',
          'The page position is invalid. Reload the list.',
        );
      const pageSize = 20;
      const events = await repository.listSecurityEvents(
        session.userId,
        after,
        pageSize + 1,
      );
      const page = events.slice(0, pageSize);
      const last = page.at(-1);

      return {
        items: page.map((event) => ({
          id: event.id,
          type: event.type,
          outcome: event.outcome,
          reason: event.reason,
          createdAt: event.createdAt.toISOString(),
          ipAddress: event.ipAddress,
          ...describeUserAgent(event.userAgent),
          currentSession:
            event.sessionId !== null && event.sessionId === session.sessionId,
          bySupport: event.staffCommandId !== null,
        })),
        nextCursor:
          events.length > pageSize && last
            ? encodeSecurityEventCursor(last)
            : null,
      };
    },
    /** Lists the signed-in person's workspaces; a support view lists only its workspace. */
    async listOrganizations(credentials: Credentials, requestId: string) {
      const token = repository.supportViews.token(credentials);
      if (token) {
        const view = await activeSupportView(token, null, null, requestId);

        return (
          await repository.withUser(view.userId, (tx) => tx.listOrganizations())
        ).filter((organization) => organization.id === view.tenantId);
      }
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
    /**
     * Resolves the caller's access to a workspace from the current session and membership.
     * With `supportView`, a support view token takes precedence over a customer session and
     * yields a read-only context for the viewed member; `read` records the first read of a path.
     * Without it, only a customer session is accepted.
     */
    async resolveTenant(
      credentials: Credentials,
      organizationId: string,
      requestId: string,
      options: { supportView?: { read: string | null } } = {},
    ) {
      const support = options.supportView;
      const token = support ? repository.supportViews.token(credentials) : null;
      if (support && token) {
        const view = await activeSupportView(
          token,
          organizationId,
          support.read,
          requestId,
        );

        return repository.withUser(view.userId, (tx) =>
          resolve(
            tx,
            { userId: view.userId, sessionId: view.id },
            organizationId,
            requestId,
            {
              id: view.id,
              mode: view.mode,
              expiresAt: new Date(view.expiresAt).toISOString(),
            },
          ),
        );
      }
      const session = await authenticate(credentials);

      return repository.withUser(session.userId, (tx) =>
        resolve(tx, session, organizationId, requestId),
      );
    },
    /**
     * Returns which of the given users can't act in the context's workspace: their membership is
     * suspended or their account disabled. Callers authorize the read that referenced them; work
     * acting as them is paused and needs a new owner.
     */
    async suspendedMembers(
      context: TenantContext,
      userIds: readonly string[],
    ): Promise<ReadonlySet<string>> {
      // Recorded principals may be names or service IDs; only user IDs can be members.
      const ids = [...new Set(userIds)].filter((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
      );
      if (!ids.length) return new Set();

      return withTenant(
        context,
        async (tx) => new Set(await tx.suspendedMembers(context.tenantId, ids)),
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
     * `members.manage`; only owners change ownership, the last active owner stays, and nobody
     * else can assign a role or change a member whose permissions exceed their own. Suspended
     * owners don't count as active owners.
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
          target.status !== 'suspended' &&
          next?.reference.key !== 'owner' &&
          members.filter(
            (m) => m.role.key === 'owner' && m.status !== 'suspended',
          ).length === 1
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
