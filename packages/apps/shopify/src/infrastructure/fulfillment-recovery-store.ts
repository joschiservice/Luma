import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';

import type {
  RecoveryRun,
  RecoveryStore,
} from '../application/fulfillment-recovery.js';
import type { RecoveryEvidence } from './fulfillment-recovery-provider.js';

/** Persists immutable recovery intent and allowlisted source evidence within the connection's tenant. */
export function createRecoveryStore(database: TenantDatabase): RecoveryStore & {
  record(
    context: TenantContext,
    connectionId: string,
    evidence: RecoveryEvidence,
  ): Promise<void>;
} {
  const get: RecoveryStore['get'] = (context, id) =>
    database.transaction(context.tenantId, async (tx) => {
      const row = (
        await tx.query<{ document: RecoveryRun; decision_id: string | null }>(
          'SELECT document,decision_id FROM shopify_fulfillment_recoveries WHERE tenant_id=$1 AND id=$2',
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
          `${context.tenantId}:${run.target.connectionId}:${run.target.fulfillmentOrderId}`,
        ]);
        const pending = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_fulfillment_claims WHERE tenant_id=$1 AND connection_id=$2 AND fulfillment_order_id=$3 AND NOT settled',
            [
              context.tenantId,
              run.target.connectionId,
              run.target.fulfillmentOrderId,
            ],
          )
        ).rows;
        if (pending.some((item) => item.run_id !== run.id))
          throw new IdentityError(
            409,
            'CONFLICT',
            'Another recovery is awaiting reconciliation. Check its outcome before another action.',
          );
        const values = [
          context.tenantId,
          run.target.connectionId,
          run.target.fulfillmentOrderId,
          run.before.revision,
        ];
        await tx.query(
          'INSERT INTO shopify_fulfillment_claims(tenant_id,connection_id,fulfillment_order_id,revision,run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [...values, run.id],
        );
        const row = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_fulfillment_claims WHERE tenant_id=$1 AND connection_id=$2 AND fulfillment_order_id=$3 AND revision=$4',
            values,
          )
        ).rows[0];
        if (row?.run_id !== run.id)
          throw new IdentityError(
            409,
            'CONFLICT',
            'Another recovery already reserved this fulfillment revision. Refresh to review it.',
          );
      }),
    settle: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_fulfillment_claims SET settled=true WHERE tenant_id=$1 AND run_id=$2 AND NOT settled',
          [context.tenantId, id],
        );
      }),
    async save(context, run) {
      await database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_fulfillment_recoveries(tenant_id,id,connection_id,fulfillment_order_id,revision,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            run.id,
            run.target.connectionId,
            run.target.fulfillmentOrderId,
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
          'This fulfillment revision already has a recovery. Refresh to review it.',
        );

      return stored;
    },
    list: (context, target) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{ document: RecoveryRun; decision_id: string | null }>(
            'SELECT document,decision_id FROM shopify_fulfillment_recoveries WHERE tenant_id=$1 AND connection_id=$2 AND fulfillment_order_id=$3 ORDER BY EXISTS (SELECT 1 FROM shopify_fulfillment_claims c WHERE c.tenant_id=shopify_fulfillment_recoveries.tenant_id AND c.run_id=shopify_fulfillment_recoveries.id AND NOT c.settled) DESC,created_at DESC LIMIT 20',
            [context.tenantId, target.connectionId, target.fulfillmentOrderId],
          )
        ).rows.map((row) => ({ ...row.document, decisionId: row.decision_id })),
      ),
    open: (context) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: RecoveryRun;
            decision_id: string | null;
          }>(
            `SELECT r.document,r.decision_id FROM shopify_fulfillment_recoveries r
             WHERE r.tenant_id=$1 AND r.created_at>now()-interval '7 days'
             AND ((r.document->'action'->>'expiresAt')::timestamptz>now()
              OR EXISTS (SELECT 1 FROM shopify_fulfillment_claims c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id))
             ORDER BY r.created_at DESC,r.id LIMIT 50`,
            [context.tenantId],
          )
        ).rows.map((row) => ({ ...row.document, decisionId: row.decision_id })),
      ),
    decision: (context, id, decisionId) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_fulfillment_recoveries SET decision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id, decisionId],
        );
      }),
    record: (context, connectionId, evidence) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_fulfillment_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,$4,$5,$6)',
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
