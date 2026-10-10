import { randomUUID } from 'node:crypto';

import type { SecurityEventType } from '@luma/identity';
import {
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
          throw new StaffError(404, 'Customer membership unavailable.');
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
            "SELECT id FROM organizations WHERE id=$1 AND data_region='EU'",
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
            'SELECT id,name,slug,status,data_region AS "dataRegion" FROM organizations WHERE id=$1 AND data_region=\'EU\'',
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
          }>(
            'SELECT m.id,m.user_id AS "userId",u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name LIMIT 101',
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
          await audit(tx, context, 'workspace.inspected', workspaceId, null, {
            grantId,
          });

          return {
            membersTruncated: members.rows.length > 100,
            connectionsTruncated: connections.rows.length > 100,
            workspace: workspace.rows[0],
            members: members.rows.slice(0, 100),
            connections: connections.rows.slice(0, 100).map((row) => ({
              id: row.id,
              provider: row.provider,
              status: row.status,
              lastSyncAt: row.last_sync_at?.toISOString() ?? null,
            })),
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
          }>(
            'SELECT id,name,email,created_at,two_factor_enabled,passkey_count FROM staff_account_profile WHERE id=$1',
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
          }>(
            'SELECT id,name,slug,status,data_region,role,custom_role_name,joined_at FROM staff_account_workspaces WHERE user_id=$1 ORDER BY lower(name),id LIMIT 101',
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
              // Memberships have no suspension state yet; every stored membership is active.
              membershipStatus: 'active' as const,
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
  };
}
