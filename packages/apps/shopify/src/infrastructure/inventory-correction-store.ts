import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';

import type {
  CorrectionRun,
  CorrectionStore,
} from '../application/inventory-correction.js';
import type { CorrectionEvidence } from './inventory-correction-provider.js';

/** Persists immutable correction intent and allowlisted source evidence within the connection's tenant. */
export function createCorrectionStore(
  database: TenantDatabase,
): CorrectionStore & {
  record(
    context: TenantContext,
    connectionId: string,
    evidence: CorrectionEvidence,
  ): Promise<void>;
} {
  const get: CorrectionStore['get'] = (context, id) =>
    database.transaction(context.tenantId, async (tx) => {
      const row = (
        await tx.query<{ document: CorrectionRun; decision_id: string | null }>(
          'SELECT document,decision_id FROM shopify_inventory_corrections WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id],
        )
      ).rows[0];

      return row ? { ...row.document, decisionId: row.decision_id } : null;
    });

  return {
    get,
    claim: (context, run) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${context.tenantId}:${run.target.connectionId}:${run.before.inventoryItemId}:${run.before.locationId}`,
        ]);
        const pending = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_inventory_claims WHERE tenant_id=$1 AND connection_id=$2 AND target_key=$3 AND NOT settled',
            [
              context.tenantId,
              run.target.connectionId,
              `${run.before.inventoryItemId}:${run.before.locationId}`,
            ],
          )
        ).rows;
        if (pending.some((item) => item.run_id !== run.id))
          throw new IdentityError(
            409,
            'CONFLICT',
            'Another correction is awaiting reconciliation. Check its outcome before another action.',
          );
        const values = [
          context.tenantId,
          run.target.connectionId,
          `${run.before.inventoryItemId}:${run.before.locationId}`,
          run.before.revision,
        ];
        await tx.query(
          'INSERT INTO shopify_inventory_claims(tenant_id,connection_id,target_key,revision,run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [...values, run.id],
        );
        const row = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_inventory_claims WHERE tenant_id=$1 AND connection_id=$2 AND target_key=$3 AND revision=$4',
            values,
          )
        ).rows[0];
        if (row?.run_id !== run.id)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Another correction already reserved this inventory revision. Refresh to review it.',
          );
      }),
    settle: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_inventory_claims SET settled=true WHERE tenant_id=$1 AND run_id=$2',
          [context.tenantId, id],
        );
      }),
    async save(context, run) {
      await database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_inventory_corrections(tenant_id,id,connection_id,position_id,revision,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            run.id,
            run.target.connectionId,
            run.target.positionId,
            run.before.revision,
            run,
          ],
        );
      });
      const stored = await get(context, run.id);
      if (
        !stored ||
        canonicalJson({ ...stored, decisionId: null }) !== canonicalJson(run)
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'This inventory revision already has a correction. Refresh to review it.',
        );

      return stored;
    },
    list: (context, target) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: CorrectionRun;
            decision_id: string | null;
          }>(
            'SELECT document,decision_id FROM shopify_inventory_corrections WHERE tenant_id=$1 AND connection_id=$2 AND position_id=$3 ORDER BY EXISTS (SELECT 1 FROM shopify_inventory_claims c WHERE c.tenant_id=shopify_inventory_corrections.tenant_id AND c.run_id=shopify_inventory_corrections.id AND NOT c.settled) DESC,created_at DESC LIMIT 20',
            [context.tenantId, target.connectionId, target.positionId],
          )
        ).rows.map((row) => ({ ...row.document, decisionId: row.decision_id })),
      ),
    decision: (context, id, decisionId) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_inventory_corrections SET decision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id, decisionId],
        );
      }),
    record: (context, connectionId, evidence) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_inventory_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,$4,$5,$6)',
          [
            context.tenantId,
            connectionId,
            evidence.id,
            evidence.kind,
            evidence.observedAt,
            evidence.document,
          ],
        );
      }),
  };
}
