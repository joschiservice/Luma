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
        const held = await tx.query(
          `SELECT 1 FROM shopify_stock_protection_incidents i CROSS JOIN LATERAL jsonb_array_elements(i.document->'view'->'positions') p
          WHERE i.tenant_id=$1 AND i.connection_id=$2 AND (p->>'positionId'=$3 OR EXISTS(SELECT 1 FROM shopify_stock_protection_actions a WHERE a.tenant_id=i.tenant_id AND a.incident_id=i.id AND a.hold_id=(p->>'id')::uuid AND a.document->'before'->>'inventoryItemId'=$4 AND a.document->'before'->>'locationId'=$5)) AND p->>'status' IN ('pending','held','tightened','releasing','unknown') LIMIT 1`,
          [
            context.tenantId,
            run.target.connectionId,
            run.target.positionId,
            run.before.inventoryItemId,
            run.before.locationId,
          ],
        );
        if (held.rowCount)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Stock protection owns this position. Release the hold before correcting stock.',
          );
        if (run.target.receipt) {
          const receiptId = run.target.receipt.commitmentId;
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`${context.tenantId}:purchase-receipt:${receiptId}`],
          );
          const previous = (
            await tx.query<{ run_id: string; dispatch: string | null }>(
              `SELECT c.run_id,e.document->'attempt'->>'dispatch' AS dispatch FROM shopify_receipt_stock_claims c JOIN shopify_inventory_corrections r ON r.tenant_id=c.tenant_id AND r.id=c.run_id LEFT JOIN executed_actions e ON e.tenant_id=c.tenant_id AND e.proposal_id=c.run_id WHERE c.tenant_id=$1 AND c.receipt_id=$2 AND NOT c.withheld AND (r.document->'target'->'receipt'->>'damagedCommitmentId') IS NOT DISTINCT FROM $3::text`,
              [
                context.tenantId,
                receiptId,
                run.target.receipt.damagedCommitmentId,
              ],
            )
          ).rows;
          if (
            previous.some(
              (row) =>
                row.run_id !== run.id && row.dispatch !== 'not_dispatched',
            )
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'This receipt already has a stock booking. Check that booking instead of applying it again.',
            );
          await tx.query(
            'INSERT INTO shopify_receipt_stock_claims(tenant_id,run_id,receipt_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [context.tenantId, run.id, receiptId],
          );
        }
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
          run.configurationKey === undefined
            ? run.before.revision
            : JSON.stringify([run.before.revision, run.configurationKey]),
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
          `UPDATE shopify_receipt_stock_claims c SET withheld=true WHERE c.tenant_id=$1 AND c.run_id=$2 AND NOT c.withheld AND NOT EXISTS(SELECT 1 FROM executed_actions e WHERE e.tenant_id=c.tenant_id AND e.proposal_id=c.run_id AND e.document->'attempt'->>'dispatch' IS DISTINCT FROM 'not_dispatched')`,
          [context.tenantId, id],
        );
        await tx.query(
          'UPDATE shopify_inventory_claims SET settled=true WHERE tenant_id=$1 AND run_id=$2 AND NOT settled',
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
    open: (context) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: CorrectionRun;
            decision_id: string | null;
          }>(
            `SELECT r.document,r.decision_id FROM shopify_inventory_corrections r
             WHERE r.tenant_id=$1 AND r.created_at>now()-interval '7 days'
             AND ((r.document->'action'->>'expiresAt')::timestamptz>now()
              OR EXISTS (SELECT 1 FROM shopify_inventory_claims c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id))
             ORDER BY r.created_at DESC,r.id LIMIT 50`,
            [context.tenantId],
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
