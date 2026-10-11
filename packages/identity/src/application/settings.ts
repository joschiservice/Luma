import type {
  Membership,
  SessionIdentity,
  TenantContext,
} from '../domain/context.js';
import {
  IdentityError,
  requireActiveMembership,
  requireChangesAllowed,
} from '../domain/context.js';
import type { Permission } from '../domain/permissions.js';
import type { PermissionSet, RoleReference } from '../domain/roles.js';
import type {
  NotificationPreferences,
  SettingsSnapshot,
  SupportAccess,
  SupportAccessDuration,
  WorkspaceInvitation,
  WorkspaceLayout,
  WorkspaceSettings,
} from '../domain/settings.js';
import type { Credentials, IdentityService } from './identity.js';

export interface InvitationRecord extends WorkspaceInvitation {
  tokenHash: string;
  acceptedBy: string | null;
}

export interface SettingsTransaction {
  /** Reads the current membership and grants after acquiring the workspace mutation lock. */
  member(userId: string): Promise<Membership | null>;
  /** Reads a built-in or custom role of this workspace, including archived roles. */
  role(roleId: string): Promise<{
    reference: RoleReference;
    permissions: PermissionSet;
    archived: boolean;
  } | null>;
  snapshot(userId: string): Promise<SettingsSnapshot>;
  command(
    id: string,
  ): Promise<{ actorId: string; request: unknown; result: unknown } | null>;
  saveCommand(
    id: string,
    actorId: string,
    request: unknown,
    result: unknown,
  ): Promise<void>;
  saveWorkspace(value: WorkspaceSettings): Promise<void>;
  savePreferences(
    userId: string,
    value: NotificationPreferences,
  ): Promise<void>;
  /** Reads and locks the member's layout, returning the default when none is saved. */
  layout(userId: string): Promise<WorkspaceLayout>;
  saveLayout(userId: string, value: WorkspaceLayout): Promise<void>;
  audit(
    actorId: string,
    type: string,
    target: string,
    before: unknown,
    after: unknown,
  ): Promise<void>;
  /** Reads support access and pending requests; lapsed access reads as not allowed. */
  supportAccess(): Promise<SupportAccess>;
  saveSupportAccess(
    value: { allowedUntil: string | null; revision: number },
    actorId: string,
  ): Promise<void>;
  supportAccessRequest(id: string): Promise<{
    id: string;
    durationHours: SupportAccessDuration;
    pending: boolean;
  } | null>;
  decideSupportAccessRequest(
    id: string,
    status: 'approved' | 'declined',
    actorId: string,
  ): Promise<void>;
  invitations(): Promise<InvitationRecord[]>;
  pendingInvitation(email: string): Promise<boolean>;
  invitation(id: string): Promise<InvitationRecord | null>;
  memberWithEmail(email: string): Promise<boolean>;
  saveInvitation(value: InvitationRecord, inviterId: string): Promise<void>;
  queueInvitation(value: InvitationRecord): Promise<void>;
  queueTest(userId: string, id: string): Promise<void>;
  email(userId: string): Promise<string>;
  accept(invitation: InvitationRecord, userId: string): Promise<void>;
}

export interface SettingsRepository {
  /** Serializes access, policy and preference writes against membership and delivery changes. */
  transaction<T>(
    organizationId: string,
    userId: string,
    operation: (tx: SettingsTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface SettingsDependencies {
  repository: SettingsRepository;
  identity: Pick<IdentityService, 'authenticate'>;
  deliveryAvailable: boolean;
  id(): string;
  now(): Date;
  token(tenantId: string, invitationId: string, generation: number): string;
  hash(value: string): string;
}

function conflict(message: string): never {
  throw new IdentityError(409, 'CONFLICT', message);
}

function unavailable(): never {
  throw new IdentityError(
    503,
    'SERVICE_UNAVAILABLE',
    'Email delivery is unavailable. Ask your administrator to configure email.',
  );
}

function publicInvitation(value: InvitationRecord): WorkspaceInvitation {
  return {
    id: value.id,
    email: value.email,
    role: value.role,
    status: value.status,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    delivery: value.delivery,
    generation: value.generation,
  };
}

/** Manages workspace settings, invitations and account preferences with durable command receipts. */
export function createSettingsService(deps: SettingsDependencies) {
  async function authorized<T>(
    context: TenantContext,
    permission: Permission | null,
    operation: (tx: SettingsTransaction, actor: Membership) => Promise<T>,
  ) {
    return deps.repository.transaction(
      context.tenantId,
      context.actor.id,
      async (tx) => {
        const actor = await tx.member(context.actor.id);
        if (!actor)
          throw new IdentityError(404, 'NOT_FOUND', 'Workspace not found');
        requireActiveMembership(actor);
        if (permission && !actor.permissions.has(permission))
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'Your role does not allow this. Ask a workspace admin for access.',
          );

        return operation(tx, actor);
      },
    );
  }

  async function command<T>(
    context: TenantContext,
    permission: Permission | null,
    input: { commandId: string; invitationId?: string; requestId?: string },
    kind: string,
    operation: (tx: SettingsTransaction, actor: Membership) => Promise<T>,
  ): Promise<T> {
    return authorized(context, permission, async (tx, actor) => {
      const request = JSON.stringify({ kind, ...input });
      const previous = await tx.command(input.commandId);
      if (previous) {
        if (
          previous.actorId !== context.actor.id ||
          previous.request !== request
        )
          conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return previous.result as T;
      }
      const result = await operation(tx, actor);
      await tx.saveCommand(input.commandId, context.actor.id, request, result);

      return result;
    });
  }

  async function proof(
    credentials: Credentials,
    input: { organizationId: string; invitationId: string; token: string },
    accept: boolean,
  ) {
    const session: SessionIdentity =
      await deps.identity.authenticate(credentials);

    return deps.repository.transaction(
      input.organizationId,
      session.userId,
      async (tx) => {
        const invitation = await tx.invitation(input.invitationId);
        const email = (await tx.email(session.userId)).toLowerCase();
        if (
          !invitation ||
          invitation.tokenHash !== deps.hash(input.token) ||
          invitation.email !== email ||
          invitation.status !== 'pending' ||
          Date.parse(invitation.expiresAt) <= deps.now().getTime()
        ) {
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'This invitation is unavailable for your account. Check the email address or ask for a new invitation.',
          );
        }
        if (invitation.role.archived)
          throw new IdentityError(
            404,
            'NOT_FOUND',
            'The role in this invitation is no longer available. Ask for a new invitation.',
          );
        if (accept) {
          if (await tx.member(session.userId))
            conflict('You already belong to this workspace.');
          await tx.accept(invitation, session.userId);
          await tx.audit(
            session.userId,
            'invitation.accepted',
            invitation.id,
            { status: 'pending' },
            {
              status: 'accepted',
              roleId: invitation.role.id,
              roleName: invitation.role.name,
            },
          );
        }
        const { workspace } = await tx.snapshot(session.userId);

        return {
          name: workspace.name,
          email: invitation.email,
          role: { id: invitation.role.id, name: invitation.role.name },
          expiresAt: invitation.expiresAt,
        };
      },
    );
  }

  return {
    /** Reconciles a command for its submitting actor after an uncertain response. */
    receipt: (context: TenantContext, commandId: string) =>
      authorized(context, null, async (tx) => {
        const saved = await tx.command(commandId);

        return { committed: saved?.actorId === context.actor.id };
      }),
    /** Reads workspace controls and the caller's preferences. */
    get: (context: TenantContext) =>
      authorized(context, null, (tx) => tx.snapshot(context.actor.id)),
    /** Saves name and timezone only if the reviewed revision is still current. */
    updateWorkspace(
      context: TenantContext,
      input: {
        commandId: string;
        revision: number;
        name: string;
        timezone: string;
      },
    ) {
      return command(
        context,
        'workspace.settings.manage',
        input,
        'workspace',
        async (tx) => {
          const before = (await tx.snapshot(context.actor.id)).workspace;
          if (before.revision !== input.revision)
            conflict('Workspace settings changed. Refresh before saving.');
          const after = {
            ...before,
            name: input.name,
            timezone: input.timezone,
            revision: before.revision + 1,
          };
          await tx.saveWorkspace(after);
          await tx.audit(
            context.actor.id,
            'workspace.updated',
            context.tenantId,
            { name: before.name, timezone: before.timezone },
            { name: after.name, timezone: after.timezone },
          );

          return tx.snapshot(context.actor.id);
        },
      );
    },
    /** Changes provider write admission for owners at the reviewed workspace revision. */
    updateWriteMode(
      context: TenantContext,
      input: {
        commandId: string;
        revision: number;
        writeMode: 'observe_only' | 'writes_enabled';
      },
    ) {
      requireChangesAllowed(context);

      return command(context, null, input, 'write_mode', async (tx, actor) => {
        if (actor.role.key !== 'owner')
          throw new IdentityError(
            403,
            'FORBIDDEN',
            'Only workspace owners can change write mode.',
          );
        const before = (await tx.snapshot(context.actor.id)).workspace;
        if (before.revision !== input.revision)
          conflict('Write settings changed. Refresh before saving.');
        if (before.writeMode !== input.writeMode) {
          const after = {
            ...before,
            writeMode: input.writeMode,
            revision: before.revision + 1,
          };
          await tx.saveWorkspace(after);
          await tx.audit(
            context.actor.id,
            'workspace.write_mode_changed',
            context.tenantId,
            { writeMode: before.writeMode },
            { writeMode: after.writeMode },
          );
        }

        return tx.snapshot(context.actor.id);
      });
    },
    /** Versions approval requirements so older reviews cannot authorize a changed policy. */
    updateApprovals(
      context: TenantContext,
      input: {
        commandId: string;
        revision: number;
        alwaysRequireApproval: boolean;
      },
    ) {
      return command(
        context,
        'workspace.approval_policy.manage',
        input,
        'approvals',
        async (tx) => {
          const before = (await tx.snapshot(context.actor.id)).workspace;
          if (before.policyRevision !== input.revision)
            conflict('Approval settings changed. Refresh before saving.');
          if (before.alwaysRequireApproval !== input.alwaysRequireApproval) {
            const after = {
              ...before,
              alwaysRequireApproval: input.alwaysRequireApproval,
              policyRevision: before.policyRevision + 1,
            };
            await tx.saveWorkspace(after);
            await tx.audit(
              context.actor.id,
              'policy.updated',
              context.tenantId,
              {
                required: before.alwaysRequireApproval,
                version: before.policyRevision,
              },
              {
                required: after.alwaysRequireApproval,
                version: after.policyRevision,
              },
            );
          }

          return tx.snapshot(context.actor.id);
        },
      );
    },
    /** Saves only the caller's email choices; in-app attention remains available. */
    updateNotifications(
      context: TenantContext,
      input: {
        commandId: string;
        revision: number;
        issues: boolean;
        connections: boolean;
      },
    ) {
      return command(context, null, input, 'notifications', async (tx) => {
        const before = (await tx.snapshot(context.actor.id)).preferences;
        if (before.revision !== input.revision)
          conflict('Email preferences changed. Refresh before saving.');
        await tx.savePreferences(context.actor.id, {
          issues: input.issues,
          connections: input.connections,
          revision: before.revision + 1,
        });

        return tx.snapshot(context.actor.id);
      });
    },
    /** Reads the caller's personal Home layout and pinned pages for this workspace. */
    layout: (context: TenantContext) =>
      authorized(context, null, (tx) => tx.layout(context.actor.id)),
    /** Saves the caller's layout only if the revision they last read is still current. */
    saveLayout(
      context: TenantContext,
      input: Omit<WorkspaceLayout, 'revision'> & { revision: number },
    ) {
      return authorized(context, null, async (tx) => {
        const before = await tx.layout(context.actor.id);
        if (before.revision !== input.revision)
          conflict(
            'Your layout changed in another session. Refresh before saving.',
          );
        const after: WorkspaceLayout = {
          home: input.home,
          pinned: input.pinned,
          revision: before.revision + 1,
        };
        await tx.saveLayout(context.actor.id, after);

        return after;
      });
    },
    /** Queues one test message per command; current membership is rechecked before sending. */
    testEmail(context: TenantContext, input: { commandId: string }) {
      return command(context, null, input, 'test', async (tx) => {
        if (!deps.deliveryAvailable) unavailable();
        const last = (await tx.snapshot(context.actor.id)).lastTest;
        if (last?.state === 'queued')
          conflict('A test email is already queued.');
        await tx.queueTest(context.actor.id, input.commandId);

        return tx.snapshot(context.actor.id);
      });
    },
    /** Reads until when Luma support may open read-only views, and pending requests. */
    supportAccess: (context: TenantContext) =>
      authorized(context, 'support_access.manage', (tx) => tx.supportAccess()),
    /**
     * Allows Luma support access for `durationHours` from now, replacing an earlier end time, if
     * the reviewed revision is still current.
     */
    allowSupportAccess(
      context: TenantContext,
      input: {
        commandId: string;
        revision: number;
        durationHours: SupportAccessDuration;
      },
    ) {
      return command(
        context,
        'support_access.manage',
        input,
        'support_access.allow',
        async (tx) => {
          const before = await tx.supportAccess();
          if (before.revision !== input.revision)
            conflict('Support access changed. Refresh before saving.');
          const allowedUntil = new Date(
            deps.now().getTime() + input.durationHours * 3600000,
          ).toISOString();
          await tx.saveSupportAccess(
            { allowedUntil, revision: before.revision + 1 },
            context.actor.id,
          );
          await tx.audit(
            context.actor.id,
            'support_access.allowed',
            context.tenantId,
            { allowedUntil: before.allowedUntil },
            { allowedUntil, durationHours: input.durationHours },
          );

          return tx.supportAccess();
        },
      );
    },
    /** Ends Luma support access now; open support views end on their next request. */
    revokeSupportAccess(
      context: TenantContext,
      input: { commandId: string; revision: number },
    ) {
      return command(
        context,
        'support_access.manage',
        input,
        'support_access.revoke',
        async (tx) => {
          const before = await tx.supportAccess();
          if (before.revision !== input.revision)
            conflict('Support access changed. Refresh before saving.');
          if (before.allowedUntil) {
            await tx.saveSupportAccess(
              { allowedUntil: null, revision: before.revision + 1 },
              context.actor.id,
            );
            await tx.audit(
              context.actor.id,
              'support_access.revoked',
              context.tenantId,
              { allowedUntil: before.allowedUntil },
              { allowedUntil: null },
            );
          }

          return tx.supportAccess();
        },
      );
    },
    /**
     * Approves or declines a pending request from Luma support. Approval allows access for the
     * requested duration from now, or keeps a later end time.
     */
    decideSupportAccessRequest(
      context: TenantContext,
      requestId: string,
      input: { commandId: string; decision: 'approve' | 'decline' },
    ) {
      return command(
        context,
        'support_access.manage',
        { ...input, requestId },
        'support_access.decide',
        async (tx) => {
          const request = await tx.supportAccessRequest(requestId);
          if (!request?.pending)
            conflict(
              'This request was already answered or has lapsed. Refresh the page.',
            );
          await tx.decideSupportAccessRequest(
            requestId,
            input.decision === 'approve' ? 'approved' : 'declined',
            context.actor.id,
          );
          const before = await tx.supportAccess();
          let allowedUntil = before.allowedUntil;
          if (input.decision === 'approve') {
            const requested = new Date(
              deps.now().getTime() + request.durationHours * 3600000,
            ).toISOString();
            allowedUntil =
              before.allowedUntil && before.allowedUntil > requested
                ? before.allowedUntil
                : requested;
            await tx.saveSupportAccess(
              { allowedUntil, revision: before.revision + 1 },
              context.actor.id,
            );
          }
          await tx.audit(
            context.actor.id,
            input.decision === 'approve'
              ? 'support_access.request_approved'
              : 'support_access.request_declined',
            requestId,
            { allowedUntil: before.allowedUntil, status: 'pending' },
            {
              allowedUntil,
              durationHours: request.durationHours,
              status: input.decision === 'approve' ? 'approved' : 'declined',
            },
          );

          return tx.supportAccess();
        },
      );
    },
    /** Lists invitations without their acceptance credentials. */
    invitations: (context: TenantContext) =>
      authorized(context, 'members.manage', async (tx) =>
        (await tx.invitations()).map(publicInvitation),
      ),
    /**
     * Creates an expiring invitation bound to an active non-owner role without granting
     * membership. Non-owners can only invite with roles whose permissions they hold.
     */
    invite(
      context: TenantContext,
      input: { commandId: string; email: string; roleId: string },
    ) {
      return command(
        context,
        'members.manage',
        input,
        'invite',
        async (tx, actor) => {
          if (!deps.deliveryAvailable) unavailable();
          const role = await tx.role(input.roleId);
          if (!role || role.archived)
            conflict(
              'This role is no longer available. Refresh and choose another role.',
            );
          if (role.reference.key === 'owner')
            conflict(
              'Invite people with another role, then make them an owner after they join.',
            );
          if (
            actor.role.key !== 'owner' &&
            !actor.permissions.covers(role.permissions)
          )
            throw new IdentityError(
              403,
              'FORBIDDEN',
              'You can only invite people with roles whose permissions you hold.',
            );
          if (await tx.memberWithEmail(input.email))
            conflict('This person is already a member.');
          const existing = await tx.pendingInvitation(input.email);
          if (existing)
            conflict(
              'An invitation already exists. Resend it to provide a new link.',
            );
          const id = deps.id();
          const invitation: InvitationRecord = {
            id,
            email: input.email,
            role: { ...role.reference, archived: false },
            status: 'pending',
            generation: 1,
            expiresAt: new Date(
              deps.now().getTime() + 7 * 86400000,
            ).toISOString(),
            createdAt: deps.now().toISOString(),
            delivery: 'queued',
            acceptedBy: null,
            tokenHash: deps.hash(deps.token(context.tenantId, id, 1)),
          };
          await tx.saveInvitation(invitation, context.actor.id);
          await tx.queueInvitation(invitation);
          await tx.audit(context.actor.id, 'invitation.created', id, null, {
            email: invitation.email,
            roleId: invitation.role.id,
            roleName: invitation.role.name,
            status: 'pending',
          });

          return publicInvitation(invitation);
        },
      );
    },
    /** Revokes the current link or replaces it with a newly expiring invitation. */
    changeInvitation(
      context: TenantContext,
      invitationId: string,
      input: {
        commandId: string;
        generation: number;
        action: 'resend' | 'revoke';
      },
    ) {
      return command(
        context,
        'members.manage',
        { ...input, invitationId },
        'invitation',
        async (tx) => {
          const before = await tx.invitation(invitationId);
          if (
            !before ||
            !['pending', 'expired'].includes(before.status) ||
            before.generation !== input.generation
          )
            conflict('The invitation changed. Refresh the team list.');
          if (input.action === 'resend' && !deps.deliveryAvailable)
            unavailable();
          if (input.action === 'resend' && before.role.archived)
            conflict(
              'The role in this invitation was archived. Revoke it and invite again with another role.',
            );
          if (
            input.action === 'resend' &&
            (await tx.memberWithEmail(before.email))
          )
            conflict('This person is already a member.');
          const after = {
            ...before,
            status:
              input.action === 'revoke'
                ? ('revoked' as const)
                : ('pending' as const),
            generation: before.generation + 1,
            delivery:
              input.action === 'revoke'
                ? ('cancelled' as const)
                : ('queued' as const),
          };
          after.tokenHash = deps.hash(
            deps.token(context.tenantId, after.id, after.generation),
          );
          after.expiresAt = new Date(
            deps.now().getTime() + 7 * 86400000,
          ).toISOString();
          await tx.saveInvitation(after, context.actor.id);
          if (input.action === 'resend') await tx.queueInvitation(after);
          await tx.audit(
            context.actor.id,
            `invitation.${input.action}`,
            invitationId,
            { status: before.status, generation: before.generation },
            { status: after.status, generation: after.generation },
          );

          return publicInvitation(after);
        },
      );
    },
    /** Requires a signed-in identity whose email matches the invitation. */
    previewInvitation: (
      credentials: Credentials,
      input: { organizationId: string; invitationId: string; token: string },
    ) => proof(credentials, input, false),
    /** Consumes the invitation and creates exactly one membership in the same transaction. */
    async acceptInvitation(
      credentials: Credentials,
      input: { organizationId: string; invitationId: string; token: string },
    ) {
      await proof(credentials, input, true);

      return { organizationId: input.organizationId };
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
