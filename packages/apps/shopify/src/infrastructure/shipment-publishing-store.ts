import type { TenantContext } from '@luma/identity';
import { canonicalJson, conflict, type TenantDatabase } from '@luma/platform';

import type {
  PublishingRun,
  PublishingStore,
} from '../application/shipment-publishing.js';
import type { PublishingEvidence } from './shipment-publishing-provider.js';

/** Persists immutable publishing intent and allowlisted source evidence within the connection's tenant. */
export function createPublishingStore(
  database: TenantDatabase,
): PublishingStore & {
  sent(
    context: TenantContext,
    runId: string,
  ): Promise<'started' | 'sent' | 'closed'>;
  fence(context: TenantContext, runId: string): Promise<void>;
  record(
    context: TenantContext,
    connectionId: string,
    evidence: PublishingEvidence,
  ): Promise<void>;
} {
  const get: PublishingStore['get'] = (context, id) =>
    database.transaction(context.tenantId, async (tx) => {
      const row = (
        await tx.query<{ document: PublishingRun; decision_id: string | null }>(
          'SELECT document,decision_id FROM shopify_shipment_publications WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id],
        )
      ).rows[0];

      return row ? { ...row.document, decisionId: row.decision_id } : null;
    });

  return {
    get,
    closed: (context, id) =>
      database.transaction(
        context.tenantId,
        async (tx) =>
          (
            await tx.query<{ closed: boolean }>(
              'SELECT closed_at IS NOT NULL AND sent_at IS NULL AS closed FROM shopify_shipment_publications WHERE tenant_id=$1 AND id=$2',
              [context.tenantId, id],
            )
          ).rows[0]?.closed ?? false,
      ),
    fence: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_shipment_publications SET closed_at=now() WHERE tenant_id=$1 AND id=$2 AND sent_at IS NULL AND closed_at IS NULL',
          [context.tenantId, id],
        );
      }),
    sent: (context, runId) =>
      database.transaction(context.tenantId, async (tx) => {
        const result = await tx.query(
          'UPDATE shopify_shipment_publications SET sent_at=now() WHERE tenant_id=$1 AND id=$2 AND sent_at IS NULL AND closed_at IS NULL RETURNING id',
          [context.tenantId, runId],
        );
        if (result.rows.length === 1) return 'started' as const;
        const state = (
          await tx.query<{ closed: boolean }>(
            'SELECT closed_at IS NOT NULL AND sent_at IS NULL AS closed FROM shopify_shipment_publications WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, runId],
          )
        ).rows[0];

        return state?.closed ? ('closed' as const) : ('sent' as const);
      }),
    claim: (context, run) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${context.tenantId}:${run.target.connectionId}:${run.target.orderId}`,
        ]);
        const pending = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_shipment_claims WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 AND NOT settled',
            [context.tenantId, run.target.connectionId, run.target.orderId],
          )
        ).rows;
        if (pending.some((item) => item.run_id !== run.id))
          throw conflict(
            'Another publishing is awaiting reconciliation. Check its outcome before another action.',
          );
        const key = `${run.choice.source.downstreamConnectionId}:${run.choice.source.shipmentId}:${run.choice.capability}:${run.choice.capability === 'fulfillment.tracking.update' ? `${run.choice.fulfillmentId}:${run.before.dispatch?.revision}` : 'create'}`;
        await tx.query(
          'INSERT INTO shopify_shipment_source_claims(tenant_id,connection_id,dispatch_key,run_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [context.tenantId, run.target.connectionId, key, run.id],
        );
        const source = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_shipment_source_claims WHERE tenant_id=$1 AND connection_id=$2 AND dispatch_key=$3',
            [context.tenantId, run.target.connectionId, key],
          )
        ).rows[0];
        if (source?.run_id !== run.id)
          throw conflict(
            'This dispatch already has a publication. Check its outcome before another action.',
          );
        if (run.choice.capability === 'fulfillment.tracking.update') {
          const sourceKey = `${run.choice.source.downstreamConnectionId}:${run.choice.source.shipmentId}`;
          const lineageKey = `lineage:${sourceKey}`;
          await tx.query(
            'INSERT INTO shopify_shipment_source_claims(tenant_id,connection_id,dispatch_key,run_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [context.tenantId, run.target.connectionId, lineageKey, run.id],
          );
          const lineage = (
            await tx.query<{ document: PublishingRun }>(
              `SELECT p.document FROM shopify_shipment_source_claims c JOIN shopify_shipment_publications p ON p.tenant_id=c.tenant_id AND p.id=c.run_id WHERE c.tenant_id=$1 AND c.connection_id=$2 AND c.dispatch_key=$3`,
              [context.tenantId, run.target.connectionId, lineageKey],
            )
          ).rows[0];
          if (
            lineage?.document.choice.capability !==
              'fulfillment.tracking.update' ||
            lineage.document.choice.fulfillmentId !== run.choice.fulfillmentId
          )
            throw conflict(
              'This dispatch is already linked to another Shopify fulfillment.',
            );
          const original = (
            await tx.query<{ id: string; fulfillment_id: string | null }>(
              `SELECT DISTINCT p.id::text,e.document->>'fulfillmentId' AS fulfillment_id FROM shopify_shipment_source_claims c JOIN shopify_shipment_publications p ON p.tenant_id=c.tenant_id AND p.id=c.run_id LEFT JOIN shopify_shipment_evidence e ON e.tenant_id=p.tenant_id AND (e.kind='acceptance' OR (e.kind='observation' AND e.document->>'kind'='verified_publication')) AND e.document->>'operationId'=p.id::text WHERE c.tenant_id=$1 AND c.connection_id=$2 AND c.dispatch_key=$3`,
              [
                context.tenantId,
                run.target.connectionId,
                `${sourceKey}:fulfillment.shipment.create:create`,
              ],
            )
          ).rows;
          if (
            original.length &&
            (original.length !== 1 ||
              original[0]?.fulfillment_id !== run.choice.fulfillmentId)
          )
            throw conflict(
              'Reconcile the original shipment publication before changing its tracking.',
            );
        }
        const values = [
          context.tenantId,
          run.target.connectionId,
          run.target.orderId,
          run.before.revision,
        ];
        await tx.query(
          'INSERT INTO shopify_shipment_claims(tenant_id,connection_id,order_id,revision,run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [...values, run.id],
        );
        const row = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_shipment_claims WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 AND revision=$4',
            values,
          )
        ).rows[0];
        if (row?.run_id !== run.id)
          throw conflict(
            'Another publishing already reserved this fulfillment revision. Refresh to review it.',
          );
      }),
    settle: (context, id, withheld = false) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_shipment_claims SET settled=true WHERE tenant_id=$1 AND run_id=$2 AND NOT settled',
          [context.tenantId, id],
        );
        if (withheld)
          await tx.query(
            'DELETE FROM shopify_shipment_source_claims WHERE tenant_id=$1 AND run_id=$2',
            [context.tenantId, id],
          );
      }),
    async save(context, run) {
      await database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_shipment_publications(tenant_id,id,connection_id,order_id,revision,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            run.id,
            run.target.connectionId,
            run.target.orderId,
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
        throw conflict(
          'This fulfillment revision already has a publishing. Refresh to review it.',
        );

      return stored;
    },
    list: (context, target) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: PublishingRun;
            decision_id: string | null;
          }>(
            'SELECT document,decision_id FROM shopify_shipment_publications WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 ORDER BY EXISTS (SELECT 1 FROM shopify_shipment_claims c WHERE c.tenant_id=shopify_shipment_publications.tenant_id AND c.run_id=shopify_shipment_publications.id AND NOT c.settled) DESC,created_at DESC LIMIT 20',
            [context.tenantId, target.connectionId, target.orderId],
          )
        ).rows.map((row) => ({ ...row.document, decisionId: row.decision_id })),
      ),
    open: (context) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: PublishingRun;
            decision_id: string | null;
          }>(
            `SELECT r.document,r.decision_id FROM shopify_shipment_publications r
             WHERE r.tenant_id=$1 AND r.created_at>now()-interval '7 days'
             AND ((r.document->'action'->>'expiresAt')::timestamptz>now()
              OR EXISTS (SELECT 1 FROM shopify_shipment_claims c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id))
             ORDER BY r.created_at DESC,r.id LIMIT 50`,
            [context.tenantId],
          )
        ).rows.map((row) => ({ ...row.document, decisionId: row.decision_id })),
      ),
    decision: (context, id, decisionId) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_shipment_publications SET decision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id, decisionId],
        );
      }),
    record: (context, connectionId, evidence) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_shipment_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,$4,$5,$6)',
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
