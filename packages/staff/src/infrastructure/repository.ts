import { randomUUID } from 'node:crypto';

import { revokeCustomerSessionsForSupport } from '@luma/identity';
import type { Pool, PoolClient } from 'pg';

import type {
  DirectoryUser,
  DirectoryWorkspace,
  StaffRepository,
} from '../application/staff.js';
import type { StaffContext, StaffPermission } from '../domain/access.js';
import { StaffError } from '../domain/access.js';
import { readAccessHistory, readWorkspaceHealth } from './health.js';

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
  };
}
