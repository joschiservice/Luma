import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import { canonicalJson, conflict, type TenantDatabase } from '@luma/platform';

import type {
  OrderEditRun,
  OrderEditStore,
} from '../application/order-edits.js';
import type { EditFence } from '../domain/order-edits.js';
import type { OrderEditEvidence } from './order-edit-provider.js';

const read = (row: { document: OrderEditRun; decision_id: string | null }) => ({
  ...row.document,
  decisionId: row.decision_id,
});

/**
 * Persists immutable edit intent, per-order claims, the one-shot commit fence and allowlisted
 * evidence within the connection's tenant.
 */
export function createOrderEditStore(
  database: TenantDatabase,
): OrderEditStore & {
  record(
    context: TenantContext,
    connectionId: string,
    evidence: OrderEditEvidence,
  ): Promise<void>;
  /** Reserves an operation for its single dispatch; false if it was reserved or closed before. */
  reserve(context: TenantContext, id: string): Promise<boolean>;
  /** Marks the commit as sent before the request leaves; false if the operation is no longer reserved. */
  send(context: TenantContext, id: string): Promise<boolean>;
  finish(
    context: TenantContext,
    id: string,
    state: 'accepted' | 'withheld' | 'rejected',
  ): Promise<void>;
  /**
   * Reads the fence, closing an operation that never sent its commit so a late dispatch cannot
   * send it anymore. Returns the state after closing.
   */
  close(context: TenantContext, id: string): Promise<EditFence>;
  /** Asks data sync to read the connection's orders again after an edit. */
  hint(context: TenantContext, connectionId: string, id: string): Promise<void>;
} {
  const get: OrderEditStore['get'] = (context, id) =>
    database.transaction(context.tenantId, async (tx) => {
      const row = (
        await tx.query<{ document: OrderEditRun; decision_id: string | null }>(
          'SELECT document,decision_id FROM shopify_order_edits WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id],
        )
      ).rows[0];

      return row ? read(row) : null;
    });

  return {
    get,
    async save(context, run) {
      await database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_order_edits(tenant_id,id,connection_id,order_id,revision,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
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
        throw conflict('This request already belongs to another order edit.');

      return stored;
    },
    claim: (context, run) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${context.tenantId}:${run.target.connectionId}:${run.target.orderId}:order-edit`,
        ]);
        const pending = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_order_edit_claims WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 AND NOT settled',
            [context.tenantId, run.target.connectionId, run.target.orderId],
          )
        ).rows;
        if (pending.some((item) => item.run_id !== run.id))
          throw conflict(
            'Another edit of this order is running or awaiting reconciliation. Check its outcome first.',
          );
        const values = [
          context.tenantId,
          run.target.connectionId,
          run.target.orderId,
          run.before.revision,
        ];
        await tx.query(
          'INSERT INTO shopify_order_edit_claims(tenant_id,connection_id,order_id,revision,run_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [...values, run.id],
        );
        const row = (
          await tx.query<{ run_id: string }>(
            'SELECT run_id FROM shopify_order_edit_claims WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 AND revision=$4',
            values,
          )
        ).rows[0];
        if (row?.run_id !== run.id)
          throw conflict(
            'Another edit already reserved this order revision. Refresh to review it.',
          );
      }),
    settle: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_order_edit_claims SET settled=true WHERE tenant_id=$1 AND run_id=$2 AND NOT settled',
          [context.tenantId, id],
        );
      }),
    list: (context, target) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: OrderEditRun;
            decision_id: string | null;
          }>(
            'SELECT document,decision_id FROM shopify_order_edits WHERE tenant_id=$1 AND connection_id=$2 AND order_id=$3 ORDER BY EXISTS (SELECT 1 FROM shopify_order_edit_claims c WHERE c.tenant_id=shopify_order_edits.tenant_id AND c.run_id=shopify_order_edits.id AND NOT c.settled) DESC,created_at DESC LIMIT 20',
            [context.tenantId, target.connectionId, target.orderId],
          )
        ).rows.map(read),
      ),
    open: (context) =>
      database.transaction(context.tenantId, async (tx) =>
        (
          await tx.query<{
            document: OrderEditRun;
            decision_id: string | null;
          }>(
            `SELECT e.document,e.decision_id FROM shopify_order_edits e
             WHERE e.tenant_id=$1 AND e.created_at>now()-interval '7 days'
             AND ((e.document->'action'->>'expiresAt')::timestamptz>now()
              OR EXISTS (SELECT 1 FROM shopify_order_edit_claims c WHERE c.tenant_id=e.tenant_id AND c.run_id=e.id))
             ORDER BY e.created_at DESC,e.id LIMIT 50`,
            [context.tenantId],
          )
        ).rows.map(read),
      ),
    decision: (context, id, decisionId) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'UPDATE shopify_order_edits SET decision_id=$3 WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, id, decisionId],
        );
      }),
    fence: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        const row = (
          await tx.query<{ state: EditFence['state']; sent_at: Date | null }>(
            'SELECT state,sent_at FROM shopify_order_edit_fences WHERE tenant_id=$1 AND run_id=$2',
            [context.tenantId, id],
          )
        ).rows[0];

        return row
          ? { state: row.state, sentAt: row.sent_at?.toISOString() ?? null }
          : null;
      }),
    reserve: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        const inserted = await tx.query(
          "INSERT INTO shopify_order_edit_fences(tenant_id,run_id,state) VALUES($1,$2,'reserved') ON CONFLICT DO NOTHING",
          [context.tenantId, id],
        );

        return inserted.rowCount === 1;
      }),
    send: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        const sent = await tx.query(
          "UPDATE shopify_order_edit_fences SET state='sent',sent_at=now(),updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND state='reserved'",
          [context.tenantId, id],
        );

        return sent.rowCount === 1;
      }),
    finish: (context, id, state) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          `UPDATE shopify_order_edit_fences SET state=$3,updated_at=now() WHERE tenant_id=$1 AND run_id=$2
           AND state=CASE WHEN $3='withheld' THEN 'reserved' ELSE 'sent' END`,
          [context.tenantId, id, state],
        );
      }),
    close: (context, id) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          "INSERT INTO shopify_order_edit_fences(tenant_id,run_id,state) VALUES($1,$2,'withheld') ON CONFLICT DO NOTHING",
          [context.tenantId, id],
        );
        await tx.query(
          "UPDATE shopify_order_edit_fences SET state='withheld',updated_at=now() WHERE tenant_id=$1 AND run_id=$2 AND state='reserved'",
          [context.tenantId, id],
        );
        const row = (
          await tx.query<{ state: EditFence['state']; sent_at: Date | null }>(
            'SELECT state,sent_at FROM shopify_order_edit_fences WHERE tenant_id=$1 AND run_id=$2',
            [context.tenantId, id],
          )
        ).rows[0]!;

        return { state: row.state, sentAt: row.sent_at?.toISOString() ?? null };
      }),
    record: (context, connectionId, evidence) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO shopify_order_edit_evidence(tenant_id,connection_id,id,kind,observed_at,document) VALUES($1,$2,$3,$4,$5,$6)',
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
    hint: (context, connectionId, id) =>
      database.transaction(context.tenantId, async (tx) => {
        await tx.query(
          'INSERT INTO connector_refresh_hints(tenant_id,connection_id,event_key,capabilities,reconcile) VALUES($1,$2,$3,$4,false) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            connectionId,
            createHash('sha256').update(`luma-oe:${id}`).digest('hex'),
            ['orders.read', 'fulfillment.read'],
          ],
        );
      }),
  };
}
