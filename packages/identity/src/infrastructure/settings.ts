import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type {
  InvitationRecord,
  SettingsRepository,
  SettingsTransaction,
} from '../application/settings.js';
import { IdentityError } from '../domain/context.js';
import {
  builtInReference,
  isBuiltInRole,
  PermissionSet,
} from '../domain/roles.js';
import type {
  SettingsSnapshot,
  SupportAccess,
  WorkspaceLayout,
} from '../domain/settings.js';
import type { MembershipRow } from './access.js';
import {
  membershipFromRow,
  membershipSelect,
  roleFromRow,
  storedRole,
} from './access.js';

/**
 * Runs a serialized workspace transaction, installing only transaction-local identity context.
 * With `readOnly` it is `READ ONLY` and takes no locks.
 */
export async function workspaceTransaction<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  operation: (tx: PoolClient, readOnly: boolean) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await tx.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
      [tenantId, userId],
    );
    if (!readOnly)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `exceptions:${tenantId}`,
      ]);
    const org = await tx.query(
      `SELECT id FROM organizations WHERE id=$1 AND status='active' AND data_region=(SELECT region FROM luma_cell_region)${readOnly ? '' : ' FOR UPDATE'}`,
      [tenantId],
    );
    if (!org.rowCount)
      throw new IdentityError(404, 'NOT_FOUND', 'Workspace not found');
    const result = await operation(tx, readOnly);
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
  readOnly: boolean,
): SettingsTransaction {
  const invitationSelect = `SELECT i.id,i.email,i.role,i.custom_role_id AS "customRoleId",r.name AS "roleName",
    r.revision AS "roleRevision",r.archived_at IS NOT NULL AS "roleArchived",
    CASE WHEN i.status='pending' AND i.expires_at<=now() THEN 'expired' ELSE i.status END AS status,
    i.generation,i.token_hash AS "tokenHash",i.accepted_by AS "acceptedBy",i.expires_at AS "expiresAt",i.created_at AS "createdAt",
    COALESCE((SELECT state FROM workspace_mail m WHERE m.tenant_id=i.tenant_id AND m.invitation_id=i.id AND m.generation=i.generation LIMIT 1),'cancelled') AS delivery
    FROM workspace_invitations i LEFT JOIN workspace_roles r ON r.tenant_id=i.tenant_id AND r.id=i.custom_role_id
    WHERE i.tenant_id=$1`;

  type InvitationRow = Omit<InvitationRecord, 'role'> & {
    role: string;
    customRoleId: string | null;
    roleName: string | null;
    roleRevision: number | null;
    roleArchived: boolean;
  };

  const invitationDto = ({
    role,
    customRoleId,
    roleName,
    roleRevision,
    roleArchived,
    ...row
  }: InvitationRow): InvitationRecord => ({
    ...row,
    role: {
      ...roleFromRow({ role, customRoleId, roleName, roleRevision }),
      archived: roleArchived,
    },
    expiresAt: new Date(row.expiresAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
  });

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
    async role(roleId) {
      if (isBuiltInRole(roleId)) {
        const reference = builtInReference(roleId);

        return {
          reference,
          permissions: PermissionSet.forRole(reference),
          archived: false,
        };
      }
      const row = (
        await tx.query<{
          name: string;
          revision: number;
          archived: boolean;
          permissions: string[];
        }>(
          `SELECT r.name,r.revision,r.archived_at IS NOT NULL AS archived,
          ARRAY(SELECT p.permission FROM workspace_role_permissions p WHERE p.tenant_id=r.tenant_id AND p.role_id=r.id) AS permissions
          FROM workspace_roles r WHERE r.tenant_id=$1 AND r.id::text=$2`,
          [tenantId, roleId],
        )
      ).rows[0];
      if (!row) return null;
      const reference = {
        id: roleId,
        key: 'custom' as const,
        name: row.name,
        builtIn: false,
        revision: row.revision,
      };

      return {
        reference,
        permissions: PermissionSet.forRole(reference, row.permissions),
        archived: row.archived,
      };
    },
    async snapshot(userId) {
      const org = (
        await tx.query<SettingsSnapshot['workspace']>(
          `SELECT o.name,o.slug,o.write_mode AS "writeMode",o.data_region AS "dataRegion",COALESCE(s.timezone,'UTC') AS timezone,
        '{"inventoryTolerance":"0","propagationSeconds":1800,"oversellPropagationSeconds":120,"stuckSeconds":7200,"stallSeconds":900,"stallMinPositions":3,"stallSharePercent":50}'::jsonb||COALESCE(s.detection,'{}'::jsonb) AS detection,COALESCE(s.revision,0) AS revision,COALESCE(s.always_require_approval,false) AS "alwaysRequireApproval",COALESCE(s.policy_revision,0) AS "policyRevision",COALESCE(s.replenishment_approval,'{"separateSend":false,"threshold":null}'::jsonb) AS "replenishmentApproval",
        COALESCE(s.require_independent_approval,true) AS "requireIndependentApproval",workspace_active_member_count() AS "activeMemberCount"
        FROM organizations o LEFT JOIN workspace_settings s ON s.tenant_id=o.id WHERE o.id=$1`,
          [tenantId],
        )
      ).rows[0]!;
      const preferences = (
        await tx.query<SettingsSnapshot['preferences']>(
          'SELECT issues,connections,morning_brief AS "morningBrief",morning_brief_time AS "morningBriefTime",revision FROM notification_preferences WHERE tenant_id=$1 AND user_id=$2',
          [tenantId, userId],
        )
      ).rows[0] ?? {
        issues: false,
        connections: false,
        morningBrief: false,
        morningBriefTime: '08:00',
        revision: 0,
      };
      const lastTest =
        (
          await tx.query<NonNullable<SettingsSnapshot['lastTest']>>(
            "SELECT id,state FROM workspace_mail WHERE tenant_id=$1 AND user_id=$2 AND kind='test' ORDER BY created_at DESC LIMIT 1",
            [tenantId, userId],
          )
        ).rows[0] ?? null;

      // Only a suppression of the account's current address pauses email.
      const paused = (
        await tx.query<{ reason: 'bounced' | 'complained' }>(
          'SELECT s.reason FROM mail_suppressions s JOIN users u ON u.id=s.user_id WHERE s.user_id=$1 AND lower(s.email)=lower(u.email)',
          [userId],
        )
      ).rows[0];

      return {
        workspace: org,
        preferences,
        deliveryAvailable,
        emailPaused: paused?.reason ?? null,
        lastTest,
      };
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
      await tx.query(
        'UPDATE organizations SET name=$2,write_mode=$3 WHERE id=$1',
        [tenantId, value.name, value.writeMode],
      );
      await tx.query(
        `INSERT INTO workspace_settings(tenant_id,timezone,revision,always_require_approval,policy_revision,require_independent_approval,detection,replenishment_approval) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(tenant_id) DO UPDATE SET timezone=$2,revision=$3,always_require_approval=$4,policy_revision=$5,require_independent_approval=$6,detection=$7,replenishment_approval=$8`,
        [
          tenantId,
          value.timezone,
          value.revision,
          value.alwaysRequireApproval,
          value.policyRevision,
          value.requireIndependentApproval,
          JSON.stringify(
            value.detection ?? {
              inventoryTolerance: '0',
              propagationSeconds: 1800,
              oversellPropagationSeconds: 120,
              stuckSeconds: 7200,
            },
          ),
          JSON.stringify(
            value.replenishmentApproval ?? {
              separateSend: false,
              threshold: null,
            },
          ),
        ],
      );
    },
    async savePreferences(userId, value) {
      await tx.query(
        `INSERT INTO notification_preferences(tenant_id,user_id,issues,connections,revision,morning_brief,morning_brief_time) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,user_id) DO UPDATE SET issues=$3,connections=$4,revision=$5,morning_brief=$6,morning_brief_time=$7`,
        [
          tenantId,
          userId,
          value.issues,
          value.connections,
          value.revision,
          value.morningBrief,
          value.morningBriefTime,
        ],
      );
      await tx.query(
        "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND user_id=$2 AND state='queued' AND ((kind='issues' AND NOT $3) OR (kind='connections' AND NOT $4) OR (kind='morning_brief' AND NOT $5))",
        [tenantId, userId, value.issues, value.connections, value.morningBrief],
      );
    },
    async layout(userId) {
      const row = (
        await tx.query<{
          document: Omit<WorkspaceLayout, 'revision'>;
          revision: number;
        }>(
          `SELECT document,revision FROM workspace_layouts WHERE tenant_id=$1 AND user_id=$2${readOnly ? '' : ' FOR UPDATE'}`,
          [tenantId, userId],
        )
      ).rows[0];

      return row
        ? {
            home: row.document.home ?? null,
            pinned: row.document.pinned ?? [],
            revision: row.revision,
          }
        : { home: null, pinned: [], revision: 0 };
    },
    async saveLayout(userId, value) {
      await tx.query(
        `INSERT INTO workspace_layouts(tenant_id,user_id,document,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,user_id) DO UPDATE SET document=$3,revision=$4,updated_at=now()`,
        [
          tenantId,
          userId,
          JSON.stringify({ home: value.home, pinned: value.pinned }),
          value.revision,
        ],
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
    async supportAccess() {
      const row = (
        await tx.query<{
          allowedUntil: Date | null;
          changedAt: Date;
          revision: number;
        }>(
          'SELECT allowed_until AS "allowedUntil",changed_at AS "changedAt",revision FROM workspace_support_access WHERE tenant_id=$1',
          [tenantId],
        )
      ).rows[0];
      const requests = await tx.query<{
        id: string;
        reason: string;
        durationHours: 24 | 72 | 168;
        requestedAt: Date;
        expiresAt: Date;
      }>(
        `SELECT id,reason,duration_hours AS "durationHours",requested_at AS "requestedAt",expires_at AS "expiresAt"
        FROM workspace_support_access_requests WHERE tenant_id=$1 AND status='pending' AND expires_at>now() ORDER BY requested_at DESC LIMIT 5`,
        [tenantId],
      );
      const allowedUntil =
        row?.allowedUntil && row.allowedUntil.getTime() > Date.now()
          ? row.allowedUntil.toISOString()
          : null;

      return {
        allowedUntil,
        changedAt: row?.changedAt.toISOString() ?? null,
        revision: row?.revision ?? 0,
        requests: requests.rows.map((request) => ({
          ...request,
          requestedAt: request.requestedAt.toISOString(),
          expiresAt: request.expiresAt.toISOString(),
        })),
      } satisfies SupportAccess;
    },
    async saveSupportAccess(value, actorId) {
      await tx.query(
        `INSERT INTO workspace_support_access(tenant_id,allowed_until,changed_by,changed_at,revision) VALUES($1,$2,$3,now(),$4)
        ON CONFLICT(tenant_id) DO UPDATE SET allowed_until=$2,changed_by=$3,changed_at=now(),revision=$4`,
        [tenantId, value.allowedUntil, actorId, value.revision],
      );
    },
    async supportAccessRequest(id) {
      return (
        (
          await tx.query<{
            id: string;
            durationHours: 24 | 72 | 168;
            pending: boolean;
          }>(
            `SELECT id,duration_hours AS "durationHours",status='pending' AND expires_at>now() AS pending
            FROM workspace_support_access_requests WHERE tenant_id=$1 AND id=$2`,
            [tenantId, id],
          )
        ).rows[0] ?? null
      );
    },
    async decideSupportAccessRequest(id, status, actorId) {
      await tx.query(
        'UPDATE workspace_support_access_requests SET status=$3,decided_by=$4,decided_at=now() WHERE tenant_id=$1 AND id=$2',
        [tenantId, id, status, actorId],
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
        await tx.query<InvitationRow>(
          `${invitationSelect} ORDER BY (i.status='pending') DESC,i.created_at DESC LIMIT 200`,
          [tenantId],
        )
      ).rows.map(invitationDto);
    },
    async invitation(id) {
      const row = (
        await tx.query<InvitationRow>(`${invitationSelect} AND i.id=$2`, [
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
        `INSERT INTO workspace_invitations(tenant_id,id,email,role,custom_role_id,status,generation,token_hash,inviter_id,expires_at,created_at) VALUES($1,$2,$3,$4,$11,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(tenant_id,id) DO UPDATE SET status=$5,generation=$6,token_hash=$7,inviter_id=$8,expires_at=$9`,
        [
          tenantId,
          value.id,
          value.email,
          storedRole(value.role.id).role,
          value.status,
          value.generation,
          value.tokenHash,
          inviterId,
          value.expiresAt,
          value.createdAt,
          storedRole(value.role.id).customRoleId,
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
        'INSERT INTO memberships(id,tenant_id,user_id,role,custom_role_id,created_at) VALUES($1,$2,$3,$4,$5,now())',
        [
          randomUUID(),
          tenantId,
          userId,
          storedRole(invitation.role.id).role,
          storedRole(invitation.role.id).customRoleId,
        ],
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

/**
 * Creates tenant-scoped settings storage on the identity pool. While `readOnly` reports true,
 * as in a support view, transactions are read-only and take no locks.
 */
export function createSettingsRepository(
  pool: Pool,
  deliveryAvailable: boolean,
  readOnly: () => boolean = () => false,
): SettingsRepository {
  return {
    transaction: (tenantId, userId, operation) =>
      workspaceTransaction(
        pool,
        tenantId,
        userId,
        (tx, readOnlyTransaction) =>
          operation(
            transaction(tx, tenantId, deliveryAvailable, readOnlyTransaction),
          ),
        readOnly(),
      ),
  };
}
