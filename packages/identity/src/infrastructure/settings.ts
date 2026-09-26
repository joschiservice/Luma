import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type {
  InvitationRecord,
  SettingsRepository,
  SettingsTransaction,
} from '../application/settings.js';
import type { Role } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import type { SettingsSnapshot } from '../domain/settings.js';

/** Runs a serialized workspace transaction, installing only transaction-local identity context. */
export async function workspaceTransaction<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  operation: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
      [tenantId, userId],
    );
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `exceptions:${tenantId}`,
    ]);
    const org = await tx.query(
      "SELECT id FROM organizations WHERE id=$1 AND status='active' AND data_region='EU' FOR UPDATE",
      [tenantId],
    );
    if (!org.rowCount)
      throw new IdentityError(404, 'NOT_FOUND', 'Workspace not found');
    const result = await operation(tx);
    await tx.query('COMMIT');

    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

function transaction(
  tx: PoolClient,
  tenantId: string,
  deliveryAvailable: boolean,
): SettingsTransaction {
  const invitationSelect = `SELECT i.id,i.email,i.role,
    CASE WHEN i.status='pending' AND i.expires_at<=now() THEN 'expired' ELSE i.status END AS status,
    i.generation,i.token_hash AS "tokenHash",i.accepted_by AS "acceptedBy",i.expires_at AS "expiresAt",i.created_at AS "createdAt",
    COALESCE((SELECT state FROM workspace_mail m WHERE m.tenant_id=i.tenant_id AND m.invitation_id=i.id AND m.generation=i.generation LIMIT 1),'cancelled') AS delivery
    FROM workspace_invitations i WHERE i.tenant_id=$1`;
  const invitationDto = (row: InvitationRecord): InvitationRecord => ({
    ...row,
    expiresAt: new Date(row.expiresAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  });

  return {
    async role(userId) {
      return (
        (
          await tx.query<{ role: Role }>(
            'SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',
            [tenantId, userId],
          )
        ).rows[0]?.role ?? null
      );
    },
    async snapshot(userId) {
      const org = (
        await tx.query<SettingsSnapshot['workspace']>(
          `SELECT o.name,o.slug,o.data_region AS "dataRegion",COALESCE(s.timezone,'UTC') AS timezone,
        COALESCE(s.revision,0) AS revision,COALESCE(s.always_require_approval,false) AS "alwaysRequireApproval",COALESCE(s.policy_revision,0) AS "policyRevision"
        FROM organizations o LEFT JOIN workspace_settings s ON s.tenant_id=o.id WHERE o.id=$1`,
          [tenantId],
        )
      ).rows[0]!;
      const preferences = (
        await tx.query<SettingsSnapshot['preferences']>(
          'SELECT issues,connections,revision FROM notification_preferences WHERE tenant_id=$1 AND user_id=$2',
          [tenantId, userId],
        )
      ).rows[0] ?? { issues: false, connections: false, revision: 0 };
      const lastTest =
        (
          await tx.query<NonNullable<SettingsSnapshot['lastTest']>>(
            "SELECT id,state FROM workspace_mail WHERE tenant_id=$1 AND user_id=$2 AND kind='test' ORDER BY created_at DESC LIMIT 1",
            [tenantId, userId],
          )
        ).rows[0] ?? null;

      return { workspace: org, preferences, deliveryAvailable, lastTest };
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
    async saveWorkspace(value) {
      await tx.query('UPDATE organizations SET name=$2 WHERE id=$1', [
        tenantId,
        value.name,
      ]);
      await tx.query(
        `INSERT INTO workspace_settings(tenant_id,timezone,revision,always_require_approval,policy_revision) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id) DO UPDATE SET timezone=$2,revision=$3,always_require_approval=$4,policy_revision=$5`,
        [
          tenantId,
          value.timezone,
          value.revision,
          value.alwaysRequireApproval,
          value.policyRevision,
        ],
      );
    },
    async savePreferences(userId, value) {
      await tx.query(
        `INSERT INTO notification_preferences(tenant_id,user_id,issues,connections,revision) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,user_id) DO UPDATE SET issues=$3,connections=$4,revision=$5`,
        [tenantId, userId, value.issues, value.connections, value.revision],
      );
      await tx.query(
        "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND user_id=$2 AND state='queued' AND ((kind='issues' AND NOT $3) OR (kind='connections' AND NOT $4))",
        [tenantId, userId, value.issues, value.connections],
      );
    },
    async audit(actorId, type, target, before, after) {
      await tx.query(
        'INSERT INTO workspace_access_events(id,tenant_id,actor_id,event_type,target_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          tenantId,
          actorId,
          type,
          target,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
    },
    async pendingInvitation(email) {
      return !!(
        await tx.query(
          "SELECT 1 FROM workspace_invitations WHERE tenant_id=$1 AND email=$2 AND status='pending'",
          [tenantId, email],
        )
      ).rowCount;
    },
    async invitations() {
      return (
        await tx.query<InvitationRecord>(
          `${invitationSelect} ORDER BY (i.status='pending') DESC,i.created_at DESC LIMIT 200`,
          [tenantId],
        )
      ).rows.map(invitationDto);
    },
    async invitation(id) {
      const row = (
        await tx.query<InvitationRecord>(`${invitationSelect} AND i.id=$2`, [
          tenantId,
          id,
        ])
      ).rows[0];

      return row ? invitationDto(row) : null;
    },
    async memberWithEmail(email) {
      return !!(
        await tx.query(
          'SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND lower(u.email)=$2',
          [tenantId, email],
        )
      ).rowCount;
    },
    async saveInvitation(value, inviterId) {
      await tx.query(
        `INSERT INTO workspace_invitations(tenant_id,id,email,role,status,generation,token_hash,inviter_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(tenant_id,id) DO UPDATE SET status=$5,generation=$6,token_hash=$7,inviter_id=$8,expires_at=$9`,
        [
          tenantId,
          value.id,
          value.email,
          value.role,
          value.status,
          value.generation,
          value.tokenHash,
          inviterId,
          value.expiresAt,
          value.createdAt,
        ],
      );
      await tx.query(
        "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND invitation_id=$2 AND state='queued'",
        [tenantId, value.id],
      );
    },
    async queueInvitation(value) {
      await tx.query(
        "INSERT INTO workspace_mail(tenant_id,id,event_key,kind,invitation_id,generation) VALUES($1,$2,$3,'invitation',$4,$5) ON CONFLICT(tenant_id,event_key) DO NOTHING",
        [
          tenantId,
          randomUUID(),
          `invitation:${value.id}:${value.generation}`,
          value.id,
          value.generation,
        ],
      );
    },
    async queueTest(userId, id) {
      await tx.query(
        "INSERT INTO workspace_mail(tenant_id,id,event_key,kind,user_id) VALUES($1,$2,$3,'test',$4)",
        [tenantId, id, `test:${id}`, userId],
      );
    },
    async email(userId) {
      return (
        (
          await tx.query<{ email: string }>(
            'SELECT email FROM users WHERE id=$1',
            [userId],
          )
        ).rows[0]?.email ?? ''
      );
    },
    async accept(invitation, userId) {
      await tx.query(
        'INSERT INTO memberships(id,tenant_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())',
        [randomUUID(), tenantId, userId, invitation.role],
      );
      await tx.query(
        "UPDATE workspace_invitations SET status='accepted',accepted_by=$3 WHERE tenant_id=$1 AND id=$2",
        [tenantId, invitation.id, userId],
      );
      await tx.query(
        "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND invitation_id=$2 AND state='queued'",
        [tenantId, invitation.id],
      );
    },
  };
}

/** Creates tenant-scoped settings storage on the identity pool. */
export function createSettingsRepository(
  pool: Pool,
  deliveryAvailable: boolean,
): SettingsRepository {
  return {
    transaction: (tenantId, userId, operation) =>
      workspaceTransaction(pool, tenantId, userId, (tx) =>
        operation(transaction(tx, tenantId, deliveryAvailable)),
      ),
  };
}
