import { randomUUID } from 'node:crypto';

import { conflict } from '@luma/platform';
import type { Pool, PoolClient } from 'pg';

import type {
  RoleEvent,
  RolesRepository,
  RolesTransaction,
  StoredRole,
} from '../application/roles.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect } from './access.js';
import { workspaceTransaction } from './settings.js';

const roleSelect = `SELECT r.id,r.name,r.description,r.revision,r.archived_at IS NOT NULL AS archived,r.updated_at AS "updatedAt",
  ARRAY(SELECT p.permission FROM workspace_role_permissions p WHERE p.tenant_id=r.tenant_id AND p.role_id=r.id ORDER BY p.permission) AS permissions
  FROM workspace_roles r WHERE r.tenant_id=$1`;

const roleDto = (row: Omit<StoredRole, 'updatedAt'> & { updatedAt: Date }) => ({
  ...row,
  updatedAt: row.updatedAt.toISOString(),
});

function duplicateName(error: unknown): never {
  if (
    typeof error === 'object' &&
    error &&
    'code' in error &&
    error.code === '23505'
  )
    throw conflict(
      'Another active role already has this name. Choose a different name.',
    );
  throw error;
}

function transaction(tx: PoolClient, tenantId: string): RolesTransaction {
  async function savePermissions(role: StoredRole) {
    await tx.query(
      'DELETE FROM workspace_role_permissions WHERE tenant_id=$1 AND role_id=$2 AND NOT (permission = ANY($3::text[]))',
      [tenantId, role.id, role.permissions],
    );
    await tx.query(
      `INSERT INTO workspace_role_permissions(tenant_id,role_id,permission)
      SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`,
      [tenantId, role.id, role.permissions],
    );
  }

  return {
    async member(userId) {
      const row = (
        await tx.query<MembershipRow>(
          `${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2`,
          [tenantId, userId],
        )
      ).rows[0];

      return row ? membershipFromRow(row) : null;
    },
    async roles() {
      return (
        await tx.query<Omit<StoredRole, 'updatedAt'> & { updatedAt: Date }>(
          `${roleSelect} ORDER BY r.created_at`,
          [tenantId],
        )
      ).rows.map(roleDto);
    },
    async role(id) {
      const row = (
        await tx.query<Omit<StoredRole, 'updatedAt'> & { updatedAt: Date }>(
          `${roleSelect} AND r.id=$2 FOR UPDATE OF r`,
          [tenantId, id],
        )
      ).rows[0];

      return row ? roleDto(row) : null;
    },
    async usage() {
      const rows = (
        await tx.query<{ id: string; members: number; invitations: number }>(
          `SELECT id,sum(members)::integer AS members,sum(invitations)::integer AS invitations FROM (
            SELECT COALESCE(custom_role_id::text,role) AS id,1 AS members,0 AS invitations FROM memberships WHERE tenant_id=$1
            UNION ALL
            SELECT COALESCE(custom_role_id::text,role),0,1 FROM workspace_invitations
            WHERE tenant_id=$1 AND status='pending' AND expires_at>now()
          ) usage GROUP BY id`,
          [tenantId],
        )
      ).rows;

      return new Map(
        rows.map((row) => [
          row.id,
          { members: row.members, invitations: row.invitations },
        ]),
      );
    },
    async command(id) {
      return (
        (
          await tx.query<{
            actorId: string;
            request: unknown;
            result: unknown;
          }>(
            'SELECT actor_id AS "actorId",request,result FROM workspace_commands WHERE tenant_id=$1 AND id=$2',
            [tenantId, id],
          )
        ).rows[0] ?? null
      );
    },
    async saveCommand(id, actorId, request, result) {
      await tx.query(
        'INSERT INTO workspace_commands(tenant_id,id,actor_id,request,result) VALUES($1,$2,$3,$4,$5)',
        [
          tenantId,
          id,
          actorId,
          JSON.stringify(request),
          JSON.stringify(result),
        ],
      );
    },
    async insert(role, actorId) {
      await tx
        .query(
          `INSERT INTO workspace_roles(tenant_id,id,name,description,revision,created_by,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
          [
            tenantId,
            role.id,
            role.name,
            role.description,
            role.revision,
            actorId,
            role.updatedAt,
          ],
        )
        .catch(duplicateName);
      await savePermissions(role);
    },
    async update(role) {
      await tx
        .query(
          `UPDATE workspace_roles SET name=$3,description=$4,revision=$5,updated_at=$6,
          archived_at=CASE WHEN $7 THEN COALESCE(archived_at,$6::timestamptz) ELSE NULL END
          WHERE tenant_id=$1 AND id=$2`,
          [
            tenantId,
            role.id,
            role.name,
            role.description,
            role.revision,
            role.updatedAt,
            role.archived,
          ],
        )
        .catch(duplicateName);
      if (!role.archived) await savePermissions(role);
    },
    async revokeInvitations(roleId) {
      const revoked = await tx.query(
        `UPDATE workspace_invitations SET status='revoked',generation=generation+1
        WHERE tenant_id=$1 AND custom_role_id=$2 AND status='pending' RETURNING id`,
        [tenantId, roleId],
      );
      if (revoked.rowCount)
        await tx.query(
          "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND invitation_id=ANY($2::uuid[]) AND state='queued'",
          [tenantId, revoked.rows.map((row: { id: string }) => row.id)],
        );

      return revoked.rowCount ?? 0;
    },
    async audit(actorId, type, roleId, before, after) {
      await tx.query(
        'INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          tenantId,
          actorId,
          type,
          roleId,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
    },
    async history(roleId, limit) {
      return (
        await tx.query<Omit<RoleEvent, 'createdAt'> & { createdAt: Date }>(
          `SELECT e.id,e.event_type AS type,e.actor_id AS "actorId",a.name AS "actorName",m.name AS "memberName",
            e.before_value AS before,e.after_value AS after,e.created_at AS "createdAt"
          FROM workspace_access_events e
          LEFT JOIN users a ON a.id=e.actor_id
          LEFT JOIN users m ON m.id::text=COALESCE(e.after_value->>'userId',e.before_value->>'userId',
            CASE WHEN e.event_type='invitation.accepted' THEN e.actor_id::text END)
          WHERE e.tenant_id=$1 AND (
            (e.target_id=$2 AND e.event_type LIKE 'role.%')
            OR (e.event_type IN ('member.add','member.update','member.remove','invitation.accepted')
              AND $2 IN (e.before_value->>'roleId',e.after_value->>'roleId')))
          ORDER BY e.created_at DESC,e.id DESC LIMIT $3`,
          [tenantId, roleId, limit],
        )
      ).rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    },
  };
}

/** Creates tenant-scoped role storage on the identity pool, serialized with membership changes. */
export function createRolesRepository(pool: Pool): RolesRepository {
  return {
    transaction: (tenantId, userId, operation) =>
      workspaceTransaction(pool, tenantId, userId, (tx) =>
        operation(transaction(tx, tenantId)),
      ),
  };
}
