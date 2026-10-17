import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { PurchaseIncomingSource } from '@luma/inventory';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import {
  type Commitment,
  type FollowUp,
  incomingLineExpectations,
  incomingSubmissionSettled,
  type PurchaseOrder,
  type Submission,
} from '@luma/procurement';

/** Reads supplier expectations only after a persisted independent submission proof; received goods are still separately approved. */
export function readNativePurchaseIncoming(
  db: TenantDatabase,
  context: TenantContext,
  purchaseOrderId: string,
): Promise<PurchaseIncomingSource | null> {
  return db.transaction(context.tenantId, async (tx) => {
    const order = (
      await tx.query<{ document: PurchaseOrder }>(
        'SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2',
        [context.tenantId, purchaseOrderId],
      )
    ).rows[0]?.document;
    if (!order || order.authority !== 'luma') return null;
    const submission = (
      await tx.query<{ document: Submission }>(
        'SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY created_at DESC,id LIMIT 1',
        [context.tenantId, purchaseOrderId],
      )
    ).rows[0]?.document;
    if (!submission) return null;
    // Submitted state is persisted only after independently reading the purchasing order or mail acceptance.
    if (!incomingSubmissionSettled(submission)) return null;
    const commitments = (
      await tx.query<{ document: Commitment }>(
        'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY recorded_at,id',
        [context.tenantId, purchaseOrderId],
      )
    ).rows.map((row) => row.document);
    const followUps = (
      await tx.query<{ document: FollowUp }>(
        'SELECT document FROM procurement_follow_ups WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY responded_at,id',
        [context.tenantId, purchaseOrderId],
      )
    ).rows.map((row) => row.document);
    const scopes = (
      await tx.query<{ location_id: string; version: string }>(
        `SELECT location_id,version::text FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND mode='own' FOR SHARE`,
        [context.tenantId],
      )
    ).rows;
    const expectations = incomingLineExpectations({
      order,
      submission,
      commitments,
      followUps,
      now: new Date(),
    });
    const lines: PurchaseIncomingSource['lines'] = [];
    let complete = true;
    for (const line of order.lines) {
      const scope = scopes.find(
        (value) => value.location_id === line.locationId,
      );
      if (!scope || !line.locationId) continue;
      const sku = (
        await tx.query<{ id: string }>(
          `SELECT e.id FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind='sku' AND (e.id::text=$2 OR e.reconciliation_key=$2 OR EXISTS(SELECT 1 FROM inventory_product_skus p WHERE p.tenant_id=e.tenant_id AND p.sku_id=e.id AND p.code=$2)) LIMIT 2`,
          [context.tenantId, line.sku],
        )
      ).rows;
      if (sku.length !== 1) {
        complete = false;
        continue;
      }
      const expectation = expectations.get(line.id)!;
      lines.push({
        lineId: line.id,
        skuId: sku[0]!.id,
        locationId: line.locationId,
        unit: line.unit,
        expectedQuantity: String(expectation.expectedQuantity),
        providerReceivedQuantity: String(expectation.providerReceivedQuantity),
        scopeVersion: scope.version,
        observedAt: expectation.observedAt,
        expectedDate: expectation.expectedDate,
        dateConfidence: expectation.dateConfidence,
      });
    }
    const evidenceRefs = [
      submission.actionId,
      ...commitments
        .filter((value) => value.status === 'confirmed')
        .map((value) => value.id),
    ];

    return {
      lines,
      complete,
      evidenceRefs,
      revision: createHash('sha256')
        .update(
          canonicalJson({
            orderRevision: order.revision,
            status: order.status,
            submissionState: submission.state,
            submission: submission.id,
            lines,
            commitments: commitments
              .filter((value) => value.status === 'confirmed')
              .map((value) => value.id),
            decisions: followUps.map((value) => value.id),
          }),
        )
        .digest('hex'),
    };
  });
}
