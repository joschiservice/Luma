import {
  IdentityError,
  makeTenantContext,
  requireRole,
  requireTenant,
} from '#modules/identity/domain/context';
import type {
  Membership,
  Organization,
  Role,
  SessionIdentity,
  TenantContext,
} from '#modules/identity/domain/context';
export type Credentials = Readonly<Record<string, string>>;
export interface IdentityTransaction {
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
    role: Role,
  ): Promise<Membership>;
  updateMember(
    organizationId: string,
    memberId: string,
    role: Role,
  ): Promise<Membership>;
  removeMember(organizationId: string, memberId: string): Promise<void>;
}
export interface IdentityRepository {
  getSession(credentials: Credentials): Promise<SessionIdentity | null>;
  withUser<T>(
    userId: string,
    operation: (tx: IdentityTransaction) => Promise<T>,
  ): Promise<T>;
}
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
    listMembers(context: TenantContext) {
      return withTenant(context, (tx) => tx.listMembers(context.tenantId));
    },
    changeMember(
      initialContext: TenantContext,
      command:
        | { action: 'add'; userId: string; role: Role }
        | { action: 'update'; memberId: string; role: Role }
        | { action: 'remove'; memberId: string },
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
        requireRole(context, ['owner', 'admin']);
        const members = await tx.listMembers(organizationId);
        const target =
          command.action === 'add'
            ? null
            : members.find((m) => m.id === command.memberId);
        if (command.action !== 'add' && !target)
          throw new IdentityError(404, 'NOT_FOUND', 'Member not found');
        if (
          target?.role === 'owner' ||
          (command.action !== 'remove' && command.role === 'owner')
        )
          requireRole(context, ['owner']);
        if (
          target?.role === 'owner' &&
          (command.action === 'remove' ||
            (command.action === 'update' && command.role !== 'owner')) &&
          members.filter((m) => m.role === 'owner').length === 1
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'An organization must have an owner',
          );
        if (command.action === 'add')
          return tx.addMember(organizationId, command.userId, command.role);
        if (command.action === 'update')
          return tx.updateMember(
            organizationId,
            command.memberId,
            command.role,
          );
        await tx.removeMember(organizationId, command.memberId);
        return null;
      });
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
