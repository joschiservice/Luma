import type {
  AccountDeletionCategory,
  AccountDeletionCommand,
  AccountDisableCategory,
  DataRegion,
  SecurityEventType,
  SupportAccountChange,
  SupportAccountDeletion,
  SupportMembershipChange,
  SupportSessionRevocation,
} from '@luma/identity';

import type { StaffContext } from '../domain/access.js';
import {
  requireRecentStaffSession,
  requireStaffPermission,
  StaffError,
} from '../domain/access.js';
import type { AuditPage, AuditQuery } from './audit.js';
import type { AccessHistoryPage, WorkspaceHealth } from './health.js';

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
}

export interface DirectoryWorkspace {
  id: string;
  name: string;
  slug: string;
  status: string;
  dataRegion: string;
}

/** @public Declaration emit names it in the inferred type of `createStaff`. */
export interface WorkspaceAccess {
  id: string;
  workspaceId: string;
  reason: string;
  expiresAt: string;
}

/** @public Declaration emit names it in the inferred type of `createStaff`. */
export interface WorkspaceDetail {
  membersTruncated: boolean;
  connectionsTruncated: boolean;
  workspace: DirectoryWorkspace;
  members: {
    id: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    owner: boolean;
    status: 'active' | 'suspended';
    suspendedAt: string | null;
    suspendedBy: 'staff' | 'customer' | 'account_deletion' | null;
    onlyWorkspace: boolean;
    accountDisabled: boolean;
  }[];
  connections: {
    id: string;
    provider: string;
    status: string;
    lastSyncAt: string | null;
  }[];
  supportAccess: {
    allowedUntil: string | null;
    request: SupportAccessRequest | null;
  };
}

/**
 * A pending request asking the workspace to allow support views.
 *
 * @public Declaration emit names it in the inferred type of `createStaff`.
 */
export interface SupportAccessRequest {
  id: string;
  durationHours: 24 | 72 | 168;
  requestedAt: string;
  expiresAt: string;
}

/** Starts a read-only support view as one member of a workspace. */
export type SupportViewInput = {
  workspaceId: string;
  userId: string;
  grantId: string;
  reason: string;
} & (
  | { mode: 'consent' }
  | {
      mode: 'emergency';
      category: 'security_incident' | 'legal_request';
      reference: string;
    }
);

/** @public Declaration emit names it in the inferred type of `createStaff`. */
export interface AccountAccess {
  id: string;
  userId: string;
  reason: string;
  expiresAt: string;
}

export interface AccountDetail {
  account: { id: string; name: string; email: string; createdAt: string };
  disabled: {
    at: string;
    category: AccountDisableCategory;
    reason: string;
    byName: string | null;
  } | null;
  deletion: {
    id: string;
    scheduledAt: string;
    eraseAfter: string;
    category: AccountDeletionCategory;
    reference: string;
    byName: string | null;
    eraseRequestedAt: string | null;
  } | null;
  security: { twoFactorEnabled: boolean; passkeys: number };
  workspacesTruncated: boolean;
  workspaces: {
    id: string;
    name: string;
    slug: string;
    status: string;
    dataRegion: string;
    role: string;
    customRoleName: string | null;
    membershipStatus: 'active' | 'suspended';
    joinedAt: string;
  }[];
  sessionsTruncated: boolean;
  sessions: {
    id: string;
    createdAt: string;
    expiresAt: string;
    lastActiveAt: string | null;
    ipAddress: string | null;
    browser: string | null;
    os: string | null;
  }[];
}

export interface AccountSecurityEvents {
  items: {
    id: string;
    type: SecurityEventType;
    outcome: 'succeeded' | 'failed';
    reason: string | null;
    createdAt: string;
    sessionId: string | null;
    ipAddress: string | null;
    browser: string | null;
    os: string | null;
    requestId: string;
    staffCommandId: string | null;
  }[];
  nextCursor: string | null;
}

export interface MembershipChangeInput {
  workspaceId: string;
  userId: string;
  grantId: string;
  action: 'suspend' | 'reactivate';
  reason: string;
  commandId: string;
  acknowledgeLastOwner: boolean;
}

/** Disables or enables one customer account under a current account grant. */
export type AccountChangeInput = {
  userId: string;
  grantId: string;
  reason: string;
  commandId: string;
} & (
  { action: 'disable'; category: AccountDisableCategory } | { action: 'enable' }
);

/** Schedules, restores or immediately erases one customer account under an account grant. */
export type AccountDeletionInput = {
  userId: string;
  grantId: string;
  reason: string;
  commandId: string;
} & AccountDeletionCommand;

export interface StaffRepository {
  /** Resolves opaque workspace placement under directory admission, with an audit entry. */
  workspacePlacement(
    context: StaffContext,
    workspaceId: string,
  ): Promise<{ id: string; region: DataRegion; status: string }>;
  directory(
    context: StaffContext,
    query: string,
  ): Promise<{
    usersTruncated: boolean;
    workspacesTruncated: boolean;
    users: DirectoryUser[];
    workspaces: DirectoryWorkspace[];
  }>;
  grant(
    context: StaffContext,
    workspaceId: string,
    reason: string,
  ): Promise<WorkspaceAccess>;
  workspace(
    context: StaffContext,
    workspaceId: string,
    grantId: string,
  ): Promise<WorkspaceDetail>;
  revoke(
    context: StaffContext,
    input: {
      workspaceId: string;
      userId: string;
      grantId: string;
      reason: string;
      commandId: string;
    },
  ): Promise<SupportSessionRevocation>;
  changeMembership(
    context: StaffContext,
    input: MembershipChangeInput,
  ): Promise<SupportMembershipChange>;
  health(
    context: StaffContext,
    workspaceId: string,
    grantId: string,
  ): Promise<WorkspaceHealth>;
  accessHistory(
    context: StaffContext,
    workspaceId: string,
    grantId: string,
    cursor: string | null,
  ): Promise<AccessHistoryPage>;
  audit(context: StaffContext, query: AuditQuery): Promise<AuditPage>;
  /** Starts a view and returns the single-use handoff token for the customer app. */
  startSupportView(
    context: StaffContext,
    input: SupportViewInput,
  ): Promise<{
    id: string;
    expiresAt: string;
    handoffExpiresAt: string;
    token: string;
  }>;
  requestSupportAccess(
    context: StaffContext,
    input: {
      workspaceId: string;
      grantId: string;
      reason: string;
      durationHours: 24 | 72 | 168;
    },
  ): Promise<SupportAccessRequest>;
  accountGrant(
    context: StaffContext,
    userId: string,
    reason: string,
  ): Promise<AccountAccess>;
  account(
    context: StaffContext,
    userId: string,
    grantId: string,
  ): Promise<AccountDetail>;
  accountSecurityEvents(
    context: StaffContext,
    userId: string,
    grantId: string,
    cursor: string | undefined,
  ): Promise<AccountSecurityEvents>;
  changeAccount(
    context: StaffContext,
    input: AccountChangeInput,
  ): Promise<SupportAccountChange>;
  changeAccountDeletion(
    context: StaffContext,
    input: AccountDeletionInput,
  ): Promise<SupportAccountDeletion>;
}

/**
 * Provides bounded staff operations using explicit privileges and tenant-scoped support grants.
 * Support views open on `customerOrigin`; without it they can't start.
 */
export function createStaffService(
  repository: StaffRepository,
  options: { customerOrigin?: string | undefined } = {},
) {
  return {
    /** Resolves a workspace ID without exposing a customer name or email. */
    workspacePlacement(context: StaffContext, workspaceId: string) {
      requireStaffPermission(context, 'staff.directory.read');

      return repository.workspacePlacement(context, workspaceId);
    },
    /** Searches minimal directory metadata; every successful search is audited. */
    directory(context: StaffContext, query: string) {
      requireStaffPermission(context, 'staff.directory.read');

      return repository.directory(context, query);
    },
    /** Opens thirty minutes of workspace inspection for the current session and records its reason. */
    grant(context: StaffContext, workspaceId: string, reason: string) {
      requireStaffPermission(context, 'staff.workspace.inspect');

      return repository.grant(context, workspaceId, reason);
    },
    /** Reads limited connection and member metadata after rechecking the support grant. */
    workspace(context: StaffContext, workspaceId: string, grantId: string) {
      requireStaffPermission(context, 'staff.workspace.inspect');

      return repository.workspace(context, workspaceId, grantId);
    },
    /** Revokes global customer sessions through identity's atomic audited command. */
    revoke(
      context: StaffContext,
      input: {
        workspaceId: string;
        userId: string;
        grantId: string;
        reason: string;
        commandId: string;
      },
    ) {
      requireStaffPermission(context, 'staff.sessions.revoke');
      requireRecentStaffSession(context);

      return repository.revoke(context, input);
    },
    /**
     * Suspends or reactivates one workspace membership through identity's atomic audited
     * command. The account and its other workspaces are unaffected.
     */
    changeMembership(context: StaffContext, input: MembershipChangeInput) {
      requireStaffPermission(context, 'staff.memberships.manage');
      requireRecentStaffSession(context);

      return repository.changeMembership(context, input);
    },
    /** Reads bounded health metadata after rechecking the support grant; each read is audited. */
    health(context: StaffContext, workspaceId: string, grantId: string) {
      requireStaffPermission(context, 'staff.workspace.inspect');

      return repository.health(context, workspaceId, grantId);
    },
    /** Pages access changes, newest first, after rechecking the support grant; each page is audited. */
    accessHistory(
      context: StaffContext,
      workspaceId: string,
      grantId: string,
      cursor: string | null,
    ) {
      requireStaffPermission(context, 'staff.workspace.inspect');

      return repository.accessHistory(context, workspaceId, grantId, cursor);
    },
    /**
     * Starts a read-only support view as one member, for up to thirty minutes, and returns the
     * customer app link with its single-use token. Consented views need `staff.view-as`;
     * emergency views need `staff.view-as.emergency` and a sign-in within fifteen minutes.
     */
    async startSupportView(context: StaffContext, input: SupportViewInput) {
      requireStaffPermission(
        context,
        input.mode === 'consent' ? 'staff.view-as' : 'staff.view-as.emergency',
      );
      if (input.mode === 'emergency') requireRecentStaffSession(context);
      if (!options.customerOrigin)
        throw new StaffError(
          503,
          'Support views aren’t set up on this server. Configure the customer app origin.',
        );
      const view = await repository.startSupportView(context, input);

      return {
        id: view.id,
        expiresAt: view.expiresAt,
        handoffExpiresAt: view.handoffExpiresAt,
        // The fragment stays in the browser: it isn't sent to servers or in Referer headers.
        url: `${options.customerOrigin}/support-view#token=${view.token}`,
      };
    },
    /** Asks the workspace's owners to allow support views; one request can be pending. */
    requestSupportAccess(
      context: StaffContext,
      input: {
        workspaceId: string;
        grantId: string;
        reason: string;
        durationHours: 24 | 72 | 168;
      },
    ) {
      requireStaffPermission(context, 'staff.view-as');

      return repository.requestSupportAccess(context, input);
    },
    /** Pages the staff audit log with optional filters; each read is itself audited. */
    audit(context: StaffContext, query: AuditQuery) {
      requireStaffPermission(context, 'staff.audit.read');

      return repository.audit(context, query);
    },
    /** Opens thirty minutes of account inspection for the current session and records its reason. */
    accountGrant(context: StaffContext, userId: string, reason: string) {
      requireStaffPermission(context, 'staff.accounts.inspect');

      return repository.accountGrant(context, userId, reason);
    },
    /** Reads account, membership, factor and session metadata after rechecking the account grant. */
    account(context: StaffContext, userId: string, grantId: string) {
      requireStaffPermission(context, 'staff.accounts.inspect');

      return repository.account(context, userId, grantId);
    },
    /** Pages through an account's security events under its account grant; each page is audited. */
    accountSecurityEvents(
      context: StaffContext,
      userId: string,
      grantId: string,
      cursor?: string,
    ) {
      requireStaffPermission(context, 'staff.accounts.inspect');

      return repository.accountSecurityEvents(context, userId, grantId, cursor);
    },
    /**
     * Disables or enables a customer account through identity's atomic audited command. Disabling
     * ends every session and locks the person out of all their workspaces; memberships stay, so
     * enabling restores them.
     */
    changeAccount(context: StaffContext, input: AccountChangeInput) {
      requireStaffPermission(context, 'staff.accounts.inspect');
      requireStaffPermission(context, 'staff.accounts.manage');
      requireRecentStaffSession(context);

      return repository.changeAccount(context, input);
    },
    /**
     * Schedules an account for deletion, restores it within the 30-day window, or erases it
     * without the window for a verified erasure request, through identity's atomic audited
     * commands. Erasure itself runs in the customer API's erasure pass.
     */
    changeAccountDeletion(context: StaffContext, input: AccountDeletionInput) {
      requireStaffPermission(context, 'staff.accounts.inspect');
      requireStaffPermission(context, 'staff.accounts.delete');
      requireRecentStaffSession(context);

      return repository.changeAccountDeletion(context, input);
    },
  };
}

type StaffService = ReturnType<typeof createStaffService>;

/** Staff HTTP composition port; callers receive operations without database handles. */
export interface StaffRuntime {
  settings: {
    publicOrigin: string;
    mode: 'local' | 'google';
    region?: DataRegion | undefined;
    regionalApiOrigins?: Partial<Record<DataRegion, string>> | undefined;
  };
  service: StaffService;
  /** Evaluates the remote directory rollout; cell isolation always applies. */
  regionalDirectoryEnabled(): Promise<boolean>;
  /** Handles only the separately namespaced staff authentication exchange. */
  authHandler(request: Request): Promise<Response>;
  /** Rechecks identity admission and session lifetime before returning current staff privileges. */
  resolveSession(
    headers: Headers,
    requestId: string,
  ): Promise<{ context: StaffContext; user: DirectoryUser }>;
  /** Checks migrations and restricted staff credentials before serving protected operations. */
  checkReadiness(): Promise<boolean>;
  /** Releases resources owned by this runtime. */
  close(): Promise<void>;
}
