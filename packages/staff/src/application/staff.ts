import type {
  SecurityEventType,
  SupportSessionRevocation,
} from '@luma/identity';

import type { StaffContext } from '../domain/access.js';
import {
  requireRecentStaffSession,
  requireStaffPermission,
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

export interface WorkspaceAccess {
  id: string;
  workspaceId: string;
  reason: string;
  expiresAt: string;
}

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
  }[];
  connections: {
    id: string;
    provider: string;
    status: string;
    lastSyncAt: string | null;
  }[];
}

export interface AccountAccess {
  id: string;
  userId: string;
  reason: string;
  expiresAt: string;
}

export interface AccountDetail {
  account: { id: string; name: string; email: string; createdAt: string };
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
    membershipStatus: 'active';
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

export interface StaffRepository {
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
}

/** Provides bounded staff operations using explicit privileges and tenant-scoped support grants. */
export function createStaffService(repository: StaffRepository) {
  return {
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
  };
}

export type StaffService = ReturnType<typeof createStaffService>;

/** Staff HTTP composition port; callers receive operations without database handles. */
export interface StaffRuntime {
  settings: { publicOrigin: string; mode: 'local' | 'google' };
  service: StaffService;
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
