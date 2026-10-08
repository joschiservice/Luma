import type { TenantContext } from '@luma/identity';
import {
  IdentityError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { AutoLinkStore } from '../application/automatic-links.js';
import type { AutoLinkRule } from '../domain/automatic-links.js';
import { autoLinkBatch, autoLinkPolicy } from '../domain/automatic-links.js';
import { readAutoLinkPreview } from './automatic-link-candidates.js';
import { createSyncStore } from './store.js';

type RuleRow = {
  id: string;
  kind: AutoLinkRule['kind'];
  target_connection_id: string;
  source_connection_id: string;
  revision: number;
  enabled: boolean;
  principal_id: string;
  state: AutoLinkRule['state'];
  message: string | null;
  last_checked_at: Date | null;
  linked: number;
};

function rule(row: RuleRow): AutoLinkRule {
  return {
    id: row.id,
    kind: row.kind,
    targetConnectionId: row.target_connection_id,
    sourceConnectionId: row.source_connection_id,
    revision: row.revision,
    enabled: row.enabled,
    principalId: row.principal_id,
    state: row.state,
    message: row.message,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    linked: row.linked,
  };
}

/**
 * Persists rules under forced RLS. The supplied owner writer must use `scoped` so candidate
 * revalidation, mapping revisions, replay and progress commit in the same transaction.
 */
export function createAutoLinkStore(
  db: TenantDatabase,
  writeLink: (
    scoped: TenantDatabase,
    context: TenantContext,
    rule: AutoLinkRule,
    candidate: { key: string; targetId: string; sourceId: string },
  ) => Promise<unknown>,
): AutoLinkStore {
  const sync = createSyncStore(db);

  return {
    connections: sync.connections,
    scopes: () =>
      db.transaction('00000000-0000-4000-8000-000000000000', async (tx) =>
        (
          await tx.query<{ tenant_id: string }>(
            'SELECT tenant_id FROM commerce_auto_link_scopes()',
          )
        ).rows.map((row) => row.tenant_id),
      ),
    list: (tenantId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<RuleRow>(
            'SELECT * FROM commerce_auto_link_rules WHERE tenant_id=$1 ORDER BY kind,id',
            [tenantId],
          )
        ).rows.map(rule),
      ),
    due: (tenantId) =>
      db.transaction(tenantId, async (tx) =>
        (
          await tx.query<RuleRow>(
            "SELECT * FROM commerce_auto_link_rules WHERE tenant_id=$1 AND enabled AND state<>'blocked' AND due_at<=now() ORDER BY due_at,id LIMIT 10",
            [tenantId],
          )
        ).rows.map(rule),
      ),
    async save(context, input) {
      requirePermission(context, 'sync.manage');
      try {
        return await db.transaction(context.tenantId, async (tx) => {
          const current = (
            await tx.query<RuleRow>(
              'SELECT * FROM commerce_auto_link_rules WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
              [context.tenantId, input.id],
            )
          ).rows[0];
          if ((current?.revision ?? 0) !== input.revision)
            throw new IdentityError(
              409,
              'CONFLICT',
              'This rule changed. Refresh before saving it.',
            );
          if (
            current &&
            (current.kind !== input.kind ||
              current.target_connection_id !== input.targetConnectionId ||
              current.source_connection_id !== input.sourceConnectionId)
          )
            throw new IdentityError(
              422,
              'CONFLICT',
              'A rule’s record type and connections cannot change. Disable it and create another rule.',
            );
          const values = [
            context.tenantId,
            input.id,
            input.kind,
            input.targetConnectionId,
            input.sourceConnectionId,
            input.revision + 1,
            input.enabled,
            context.actor.id,
            input.enabled ? 'waiting' : 'disabled',
          ];
          const saved = await tx.query<RuleRow>(
            `INSERT INTO commerce_auto_link_rules
            (tenant_id,id,kind,target_connection_id,source_connection_id,revision,enabled,principal_id,state)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT(tenant_id,id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,
             principal_id=EXCLUDED.principal_id,state=EXCLUDED.state,message=NULL,due_at=now()
            RETURNING *`,
            values,
          );
          await tx.query(
            `INSERT INTO commerce_auto_link_rule_revisions(tenant_id,rule_id,revision,enabled,actor_id)
            VALUES($1,$2,$3,$4,$5)`,
            [
              context.tenantId,
              input.id,
              input.revision + 1,
              input.enabled,
              context.actor.id,
            ],
          );

          return rule(saved.rows[0]!);
        });
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23505'
        )
          throw new IdentityError(
            409,
            'CONFLICT',
            'A rule already exists for these connections and this record type. Refresh to use it.',
          );
        throw error;
      }
    },
    preview: (tenantId, pair) =>
      db.transaction(
        tenantId,
        (tx) => readAutoLinkPreview(tx, tenantId, pair),
        { readOnlySnapshot: true },
      ),
    async apply(context, ruleId) {
      requirePermission(context, 'sync.manage');
      await db.transaction(context.tenantId, async (tx) => {
        // The same lock as ingestion links excludes concurrent imports and manual remapping.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `commerce-ingestion:${context.tenantId}`,
        ]);
        const row = (
          await tx.query<RuleRow>(
            `SELECT * FROM commerce_auto_link_rules WHERE tenant_id=$1
          AND id=$2 AND enabled AND state<>'blocked' AND due_at<=now() FOR UPDATE SKIP LOCKED`,
            [context.tenantId, ruleId],
          )
        ).rows[0];
        if (!row) return;
        if (row.principal_id !== context.actor.id) return;
        const value = rule(row);
        const preview = await readAutoLinkPreview(tx, context.tenantId, value);
        const scoped: TenantDatabase = {
          transaction: async (tenantId, next) => {
            requireTenant(context, tenantId);

            return next(tx);
          },
        };
        let linked = 0;
        for (const candidate of autoLinkBatch(preview)) {
          await writeLink(scoped, context, value, candidate);
          linked += 1;
        }
        await tx.query(
          `UPDATE commerce_auto_link_rules SET state=$3,message=$4,last_checked_at=now(),
          linked=linked+$5,due_at=now()+$6*interval '1 millisecond' WHERE tenant_id=$1 AND id=$2`,
          [
            context.tenantId,
            ruleId,
            preview.ready ? 'active' : 'waiting',
            preview.message,
            linked,
            preview.counts.eligible > autoLinkPolicy.batchSize
              ? 0
              : autoLinkPolicy.intervalMs,
          ],
        );
      });
    },
    block: (tenantId, ruleId, revision, state) =>
      db.transaction(tenantId, async (tx) => {
        await tx.query(
          `UPDATE commerce_auto_link_rules SET state=$4,message=$5,last_checked_at=now(),
        due_at=now()+interval '1 minute' WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND enabled`,
          [
            tenantId,
            ruleId,
            revision,
            state,
            state === 'blocked'
              ? 'The person this rule runs as no longer manages imports. Preview and enable it again with your access.'
              : 'Luma could not apply this rule. This attempt was rolled back; it will retry.',
          ],
        );
      }),
  };
}
