import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type {
  AccountDeletionCategory,
  AccountDisableCategory,
  SecurityEventType,
} from '@luma/identity';
import {
  changeAccountDeletionForSupport,
  changeAccountForSupport,
  changeMembershipForSupport,
  decodeSecurityEventCursor,
  describeUserAgent,
  encodeSecurityEventCursor,
  revokeCustomerSessionsForSupport,
} from '@luma/identity';
import type { Pool, PoolClient } from 'pg';

import type {
  AccountDetail,
  AccountSecurityEvents,
  DirectoryUser,
  DirectoryWorkspace,
  StaffRepository,
} from '../application/staff.js';
import type { StaffContext, StaffPermission } from '../domain/access.js';
import { StaffError } from '../domain/access.js';
import { readStaffAudit } from './audit.js';
import { readAccessHistory, readWorkspaceHealth } from './health.js';

// State conflicts raised by support functions, by their exception message.
const stateConflicts: Record<string, string> = {
  'last active owner':
    'This person is the workspace’s only active owner. Acknowledge that the workspace will have no active owner.',
  'already suspended':
    'This membership is already suspended. Refresh the workspace.',
  'already active': 'This membership is already active. Refresh the workspace.',
  'consent required':
    'This workspace doesn’t allow Luma support access. Request access, or ask an owner to allow it.',
  'member suspended':
    'This person’s access to the workspace is suspended, so there is nothing to view.',
  'workspace inactive':
    'This workspace is suspended or closed, so it can’t be viewed.',
  'request pending': 'A request is already waiting for the workspace’s answer.',
  'access allowed': 'The workspace already allows support access.',
  'account disabled':
    'This person’s account is disabled, so there is nothing to view.',
  'already disabled': 'This account is already disabled. Refresh the account.',
  'already enabled': 'This account is already enabled. Refresh the account.',
  'deletion scheduled':
    'This account is scheduled for deletion. Restore the account instead.',
  'already scheduled':
    'This account is already scheduled for deletion. Refresh the account.',
  'sole owner':
    'This person is the only owner of a workspace. Transfer ownership first, or close the workspace.',
  'not scheduled':
    'This account isn’t scheduled for deletion. Refresh the account.',
  'erasure requested':
    'Erasure of this account was requested, so it can’t be restored.',
};

/** Creates a deliberately narrow cross-owner read adapter and identity support command adapter. */
export function createStaffRepository(pool: Pool): StaffRepository {
  async function transaction<T>(
    context: StaffContext,
    grantId: string | null,
    permission: StaffPermission,
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        "SELECT set_config('staff.user_id',$1,true),set_config('staff.session_id',$2,true),set_config('staff.grant_id',$3,true)",
        [context.userId, context.sessionId, grantId ?? ''],
      );
      const access = await tx.query<{ allowed: boolean }>(
        'SELECT staff_has_access($1) AS allowed',
        [permission],
      );
      if (!access.rows[0]?.allowed)
        throw new StaffError(403, 'Staff access is unavailable.');
      const result = await operation(tx);
      await tx.query('COMMIT');

      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      if (error instanceof StaffError) throw error;
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === '42501')
          throw new StaffError(403, 'Staff access is unavailable.');
        if (error.code === '23505')
          throw new StaffError(
            409,
            'Command ID was already used for another action.',
          );
        if (error.code === 'P0002')
          throw new StaffError(
            404,
            'message' in error && error.message === 'account unavailable'
              ? 'Customer account unavailable.'
              : 'Customer membership unavailable.',
          );
        if (error.code === '22023')
          throw new StaffError(400, 'Check the reason and details.');
        if (error.code === '55000' && 'message' in error)
          throw new StaffError(
            409,
            stateConflicts[String(error.message)] ??
              'The workspace changed. Refresh it.',
          );
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  async function audit(
    tx: PoolClient,
    context: StaffContext,
    event: string,
    workspaceId: string | null,
    reason: string | null,
    details: Record<string, unknown> = {},
  ) {
    await tx.query(
      'INSERT INTO staff_audit(staff_user_id,staff_session_id,tenant_id,event,request_id,reason,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        context.userId,
        context.sessionId,
        workspaceId,
        event,
        context.requestId,
        reason,
        JSON.stringify(details),
      ],
    );
  }

  async function validateGrant(tx: PoolClient, workspaceId: string) {
    const result = await tx.query<{ allowed: boolean }>(
      'SELECT staff_has_workspace_access($1) AS allowed',
      [workspaceId],
    );
    if (!result.rows[0]?.allowed)
      throw new StaffError(
        403,
        'Workspace support access has expired or is unavailable.',
      );
  }

  async function validateAccountGrant(tx: PoolClient, userId: string) {
    const result = await tx.query<{ allowed: boolean }>(
      'SELECT staff_has_account_access($1) AS allowed',
      [userId],
    );
    if (!result.rows[0]?.allowed)
      throw new StaffError(
        403,
        'Account support access has expired or is unavailable.',
      );
  }

  return {
    workspacePlacement(context, workspaceId) {
      return transaction(context, null, 'staff.directory.read', async (tx) => {
        const result = await tx.query<{
          id: string;
          region: StaffContext['region'];
          status: string;
        }>(
          'SELECT id,data_region AS region,status FROM organizations WHERE id=$1 AND data_region=(SELECT region FROM luma_cell_region)',
          [workspaceId],
        );
        const placement = result.rows[0];
        if (!placement)
          throw new StaffError(404, 'Workspace is unavailable in this region.');
        await audit(
          tx,
          context,
          'directory.placement-resolved',
          workspaceId,
          null,
          { region: placement.region },
        );

        return placement;
      });
    },
    directory(context, query) {
      return transaction(context, null, 'staff.directory.read', async (tx) => {
        const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
        const users = await tx.query<DirectoryUser>(
          'SELECT id,name,email FROM users WHERE email ILIKE $1 OR name ILIKE $1 ORDER BY email LIMIT 26',
          [pattern],
        );
        const workspaces = await tx.query<DirectoryWorkspace>(
          'SELECT id,name,slug,status,data_region AS "dataRegion" FROM staff_search_workspaces($1)',
          [pattern],
        );
        await audit(tx, context, 'directory.searched', null, null, {
          queryLength: query.length,
          userResults: users.rowCount,
          userIds: users.rows.slice(0, 25).map((user) => user.id),
          workspaceIds: workspaces.rows
            .slice(0, 25)
            .map((workspace) => workspace.id),
          workspaceResults: workspaces.rowCount,
        });

        return {
          usersTruncated: users.rows.length > 25,
          workspacesTruncated: workspaces.rows.length > 25,
          users: users.rows.slice(0, 25),
          workspaces: workspaces.rows.slice(0, 25),
        };
      });
    },
    grant(context, workspaceId, reason) {
      return transaction(
        context,
        null,
        'staff.workspace.inspect',
        async (tx) => {
          const workspace = await tx.query(
            'SELECT id FROM organizations WHERE id=$1 AND data_region=(SELECT region FROM luma_cell_region)',
            [workspaceId],
          );
          if (!workspace.rowCount)
            throw new StaffError(
              404,
              'Workspace is unavailable in this region.',
            );
          const id = randomUUID();
          const result = await tx.query<{ expiresAt: Date }>(
            'INSERT INTO staff_support_grants(id,staff_user_id,staff_session_id,tenant_id,reason,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'30 minutes\') RETURNING expires_at AS "expiresAt"',
            [id, context.userId, context.sessionId, workspaceId, reason],
          );
          await audit(
            tx,
            context,
            'workspace.access.opened',
            workspaceId,
            reason,
            { grantId: id },
          );

          return {
            id,
            workspaceId,
            reason,
            expiresAt: result.rows[0]!.expiresAt.toISOString(),
          };
        },
      );
    },
    workspace(context, workspaceId, grantId) {
      return transaction(
        context,
        grantId,
        'staff.workspace.inspect',
        async (tx) => {
          await validateGrant(tx, workspaceId);
          const workspace = await tx.query<DirectoryWorkspace>(
            'SELECT id,name,slug,status,data_region AS "dataRegion" FROM organizations WHERE id=$1 AND data_region=(SELECT region FROM luma_cell_region)',
            [workspaceId],
          );
          if (!workspace.rows[0])
            throw new StaffError(404, 'Workspace unavailable.');
          const members = await tx.query<{
            id: string;
            userId: string;
            name: string;
            email: string;
            role: string;
            owner: boolean;
            status: 'active' | 'suspended';
            suspendedAt: Date | null;
            suspendedBy: 'staff' | 'customer' | 'account_deletion' | null;
            onlyWorkspace: boolean;
            accountDisabled: boolean;
          }>(
            'SELECT m.id,m.user_id AS "userId",u.name,u.email,m.role,m.role=\'owner\' AS owner,m.status,m.suspended_at AS "suspendedAt",m.suspended_by_kind AS "suspendedBy",a.only_workspace AS "onlyWorkspace",a.account_disabled AS "accountDisabled" FROM memberships m JOIN users u ON u.id=m.user_id JOIN staff_workspace_member_accounts($1) a ON a.user_id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name LIMIT 101',
            [workspaceId],
          );
          const connections = await tx.query<{
            id: string;
            provider: string;
            status: string;
            last_sync_at: Date | null;
          }>(
            'SELECT id,provider,status,last_sync_at FROM staff_connection_summary WHERE tenant_id=$1 ORDER BY id LIMIT 101',
            [workspaceId],
          );
          const supportAccess = await tx.query<{
            status: {
              allowedUntil: string | null;
              request: {
                id: string;
                durationHours: 24 | 72 | 168;
                requestedAt: string;
                expiresAt: string;
              } | null;
            };
          }>('SELECT support_access_status($1) AS status', [workspaceId]);
          const access = supportAccess.rows[0]!.status;
          await audit(tx, context, 'workspace.inspected', workspaceId, null, {
            grantId,
          });

          return {
            membersTruncated: members.rows.length > 100,
            connectionsTruncated: connections.rows.length > 100,
            workspace: workspace.rows[0],
            members: members.rows.slice(0, 100).map((row) => ({
              ...row,
              suspendedAt: row.suspendedAt?.toISOString() ?? null,
            })),
            connections: connections.rows.slice(0, 100).map((row) => ({
              id: row.id,
              provider: row.provider,
              status: row.status,
              lastSyncAt: row.last_sync_at?.toISOString() ?? null,
            })),
            supportAccess: {
              allowedUntil: access.allowedUntil
                ? new Date(access.allowedUntil).toISOString()
                : null,
              request: access.request
                ? {
                    ...access.request,
                    requestedAt: new Date(
                      access.request.requestedAt,
                    ).toISOString(),
                    expiresAt: new Date(access.request.expiresAt).toISOString(),
                  }
                : null,
            },
          };
        },
      );
    },
    revoke(context, input) {
      return transaction(
        context,
        input.grantId,
        'staff.sessions.revoke',
        async (tx) => {
          await validateGrant(tx, input.workspaceId);

          return revokeCustomerSessionsForSupport(tx, {
            ...input,
            requestId: context.requestId,
          });
        },
      );
    },
    changeMembership(context, input) {
      return transaction(
        context,
        input.grantId,
        'staff.memberships.manage',
        async (tx) => {
          await validateGrant(tx, input.workspaceId);

          return changeMembershipForSupport(tx, {
            ...input,
            requestId: context.requestId,
          });
        },
      );
    },
    health(context, workspaceId, grantId) {
      return transaction(
        context,
        grantId,
        'staff.workspace.inspect',
        async (tx) => {
          await validateGrant(tx, workspaceId);
          const health = await readWorkspaceHealth(tx, workspaceId);
          await audit(tx, context, 'workspace.health.read', workspaceId, null, {
            grantId,
          });

          return health;
        },
      );
    },
    accessHistory(context, workspaceId, grantId, cursor) {
      return transaction(
        context,
        grantId,
        'staff.workspace.inspect',
        async (tx) => {
          await validateGrant(tx, workspaceId);
          const page = await readAccessHistory(tx, workspaceId, cursor);
          await audit(
            tx,
            context,
            'workspace.access-history.read',
            workspaceId,
            null,
            { grantId, cursor, events: page.events.length },
          );

          return page;
        },
      );
    },
    startSupportView(context, input) {
      const token = randomBytes(32).toString('base64url');

      return transaction(
        context,
        input.grantId,
        input.mode === 'consent' ? 'staff.view-as' : 'staff.view-as.emergency',
        async (tx) => {
          await validateGrant(tx, input.workspaceId);
          const result = await tx.query<{
            view: { id: string; expiresAt: string; handoffExpiresAt: string };
          }>('SELECT support_view_start($1,$2,$3,$4,$5,$6,$7,$8) AS view', [
            input.workspaceId,
            input.userId,
            input.mode,
            input.reason,
            input.mode === 'emergency' ? input.category : null,
            input.mode === 'emergency' ? input.reference : null,
            createHash('sha256').update(token).digest('hex'),
            context.requestId,
          ]);
          const view = result.rows[0]!.view;

          return {
            id: view.id,
            expiresAt: new Date(view.expiresAt).toISOString(),
            handoffExpiresAt: new Date(view.handoffExpiresAt).toISOString(),
            token,
          };
        },
      );
    },
    requestSupportAccess(context, input) {
      return transaction(
        context,
        input.grantId,
        'staff.view-as',
        async (tx) => {
          await validateGrant(tx, input.workspaceId);
          const result = await tx.query<{
            request: {
              id: string;
              durationHours: 24 | 72 | 168;
              requestedAt: string;
              expiresAt: string;
            };
          }>('SELECT support_access_request($1,$2,$3,$4) AS request', [
            input.workspaceId,
            input.reason,
            input.durationHours,
            context.requestId,
          ]);
          const request = result.rows[0]!.request;

          return {
            ...request,
            requestedAt: new Date(request.requestedAt).toISOString(),
            expiresAt: new Date(request.expiresAt).toISOString(),
          };
        },
      );
    },
    audit(context, query) {
      return transaction(context, null, 'staff.audit.read', async (tx) => {
        const page = await readStaffAudit(tx, query);
        const { cursor, ...filters } = query;
        await audit(tx, context, 'staff.audit.read', null, null, {
          filters,
          cursor: cursor ?? null,
          entries: page.entries.length,
        });

        return page;
      });
    },
    accountGrant(context, userId, reason) {
      return transaction(
        context,
        null,
        'staff.accounts.inspect',
        async (tx) => {
          const account = await tx.query('SELECT id FROM users WHERE id=$1', [
            userId,
          ]);
          if (!account.rowCount)
            throw new StaffError(404, 'Customer account unavailable.');
          const id = randomUUID();
          const result = await tx.query<{ expiresAt: Date }>(
            'INSERT INTO staff_account_grants(id,staff_user_id,staff_session_id,user_id,reason,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval \'30 minutes\') RETURNING expires_at AS "expiresAt"',
            [id, context.userId, context.sessionId, userId, reason],
          );
          await audit(tx, context, 'account.access.opened', null, reason, {
            grantId: id,
            userId,
          });

          return {
            id,
            userId,
            reason,
            expiresAt: result.rows[0]!.expiresAt.toISOString(),
          };
        },
      );
    },
    account(context, userId, grantId) {
      return transaction(
        context,
        grantId,
        'staff.accounts.inspect',
        async (tx): Promise<AccountDetail> => {
          await validateAccountGrant(tx, userId);
          const profile = await tx.query<{
            id: string;
            name: string;
            email: string;
            created_at: Date;
            two_factor_enabled: boolean;
            passkey_count: number;
            disabled_at: Date | null;
            disabled_reason_category: AccountDisableCategory | null;
            disabled_reason: string | null;
            disabled_by_name: string | null;
            deletion_id: string | null;
            deletion_scheduled_at: Date | null;
            deletion_erase_after: Date | null;
            deletion_reason_category: AccountDeletionCategory | null;
            deletion_reference: string | null;
            deletion_scheduled_by_name: string | null;
            deletion_erase_requested_at: Date | null;
          }>(
            'SELECT id,name,email,created_at,two_factor_enabled,passkey_count,disabled_at,disabled_reason_category,disabled_reason,disabled_by_name,deletion_id,deletion_scheduled_at,deletion_erase_after,deletion_reason_category,deletion_reference,deletion_scheduled_by_name,deletion_erase_requested_at FROM staff_account_profile WHERE id=$1',
            [userId],
          );
          const account = profile.rows[0];
          if (!account)
            throw new StaffError(404, 'Customer account unavailable.');
          const workspaces = await tx.query<{
            id: string;
            name: string;
            slug: string;
            status: string;
            data_region: string;
            role: string;
            custom_role_name: string | null;
            joined_at: Date;
            membership_status: 'active' | 'suspended';
          }>(
            'SELECT id,name,slug,status,data_region,role,custom_role_name,joined_at,membership_status FROM staff_account_workspaces WHERE user_id=$1 ORDER BY lower(name),id LIMIT 101',
            [userId],
          );
          const sessions = await tx.query<{
            id: string;
            created_at: Date;
            expires_at: Date;
            last_active_at: Date | null;
            ip_address: string | null;
            user_agent: string | null;
          }>(
            'SELECT id,created_at,expires_at,last_active_at,ip_address,user_agent FROM staff_account_sessions WHERE user_id=$1 ORDER BY coalesce(last_active_at,created_at) DESC,id LIMIT 101',
            [userId],
          );
          await audit(tx, context, 'account.inspected', null, null, {
            grantId,
            userId,
          });

          return {
            account: {
              id: account.id,
              name: account.name,
              email: account.email,
              createdAt: account.created_at.toISOString(),
            },
            disabled:
              account.disabled_at &&
              account.disabled_reason_category &&
              account.disabled_reason
                ? {
                    at: account.disabled_at.toISOString(),
                    category: account.disabled_reason_category,
                    reason: account.disabled_reason,
                    byName: account.disabled_by_name,
                  }
                : null,
            deletion:
              account.deletion_id &&
              account.deletion_scheduled_at &&
              account.deletion_erase_after &&
              account.deletion_reason_category &&
              account.deletion_reference
                ? {
                    id: account.deletion_id,
                    scheduledAt: account.deletion_scheduled_at.toISOString(),
                    eraseAfter: account.deletion_erase_after.toISOString(),
                    category: account.deletion_reason_category,
                    reference: account.deletion_reference,
                    byName: account.deletion_scheduled_by_name,
                    eraseRequestedAt:
                      account.deletion_erase_requested_at?.toISOString() ??
                      null,
                  }
                : null,
            security: {
              twoFactorEnabled: account.two_factor_enabled,
              passkeys: account.passkey_count,
            },
            workspacesTruncated: workspaces.rows.length > 100,
            workspaces: workspaces.rows.slice(0, 100).map((row) => ({
              id: row.id,
              name: row.name,
              slug: row.slug,
              status: row.status,
              dataRegion: row.data_region,
              role: row.role,
              customRoleName: row.custom_role_name,
              membershipStatus: row.membership_status,
              joinedAt: row.joined_at.toISOString(),
            })),
            sessionsTruncated: sessions.rows.length > 100,
            sessions: sessions.rows.slice(0, 100).map((row) => ({
              id: row.id,
              createdAt: row.created_at.toISOString(),
              expiresAt: row.expires_at.toISOString(),
              lastActiveAt: row.last_active_at?.toISOString() ?? null,
              ipAddress: row.ip_address,
              ...describeUserAgent(row.user_agent),
            })),
          };
        },
      );
    },
    accountSecurityEvents(context, userId, grantId, cursor) {
      const after = cursor ? decodeSecurityEventCursor(cursor) : null;
      if (cursor && !after)
        throw new StaffError(400, 'The page position is invalid.');
      const pageSize = 25;

      return transaction(
        context,
        grantId,
        'staff.accounts.inspect',
        async (tx): Promise<AccountSecurityEvents> => {
          await validateAccountGrant(tx, userId);
          const result = await tx.query<{
            id: string;
            event_type: SecurityEventType;
            outcome: 'succeeded' | 'failed';
            reason_code: string | null;
            session_id: string | null;
            ip_address: string | null;
            user_agent: string | null;
            request_id: string;
            staff_command_id: string | null;
            created_at: Date;
          }>(
            'SELECT id,event_type,outcome,reason_code,session_id,ip_address,user_agent,request_id,staff_command_id,created_at FROM staff_account_security_events WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
            [userId, after?.createdAt ?? null, after?.id ?? null, pageSize + 1],
          );
          const rows = result.rows.slice(0, pageSize);
          await audit(
            tx,
            context,
            'account.security-events.inspected',
            null,
            null,
            { grantId, userId, events: rows.length, firstPage: !after },
          );
          const last = rows.at(-1);

          return {
            items: rows.map((row) => ({
              id: row.id,
              type: row.event_type,
              outcome: row.outcome,
              reason: row.reason_code,
              createdAt: row.created_at.toISOString(),
              sessionId: row.session_id,
              ipAddress: row.ip_address,
              ...describeUserAgent(row.user_agent),
              requestId: row.request_id,
              staffCommandId: row.staff_command_id,
            })),
            nextCursor:
              result.rows.length > pageSize && last
                ? encodeSecurityEventCursor({
                    createdAt: last.created_at,
                    id: last.id,
                  })
                : null,
          };
        },
      );
    },
    changeAccount(context, input) {
      return transaction(
        context,
        input.grantId,
        'staff.accounts.manage',
        async (tx) => {
          await validateAccountGrant(tx, input.userId);

          return changeAccountForSupport(tx, {
            ...input,
            requestId: context.requestId,
          });
        },
      );
    },
    changeAccountDeletion(context, input) {
      return transaction(
        context,
        input.grantId,
        'staff.accounts.delete',
        async (tx) => {
          await validateAccountGrant(tx, input.userId);

          return changeAccountDeletionForSupport(tx, {
            ...input,
            requestId: context.requestId,
          });
        },
      );
    },
  };
}
