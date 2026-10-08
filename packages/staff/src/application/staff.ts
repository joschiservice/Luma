import type { SupportSessionRevocation } from '@luma/identity';

import type { StaffContext } from '../domain/access.js';
import {
  requireRecentStaffSession,
  requireStaffPermission,
} from '../domain/access.js';

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
