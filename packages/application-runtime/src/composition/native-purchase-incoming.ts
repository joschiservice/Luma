import { createHash } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { PurchaseIncomingSource } from '@luma/inventory';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import {
  type Commitment,
  defaultSupplierTerms,
  type FollowUp,
  orderProgress,
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
    if (
      submission.state === 'submitted' &&
      (submission.channel === 'email'
        ? !submission.outgoing?.sentMessageId
        : !submission.externalOrder)
    )
      return null;
    if (
      submission.state !== 'submitted' &&
      !['failed', 'rejected', 'expired'].includes(submission.state)
    )
      return null;
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
    const progress = orderProgress({
      order,
      submission,
      commitments,
      followUps,
      terms: defaultSupplierTerms,
      draftVerified: false,
      supplierLinked: false,
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
      const lineProgress = progress.lines.find(
        (value) => value.lineId === line.id,
      )!;
      const shortage = commitments
        .filter(
          (value) =>
            value.lineId === line.id &&
            value.kind === 'shortage' &&
            value.status === 'confirmed',
        )
        .at(-1);
      const disposition = shortage
        ? followUps
            .filter(
              (value) =>
                value.key === `receipt_difference:${shortage.id}` ||
                value.key.startsWith(`receipt_difference:${shortage.id}:`),
            )
            .at(-1)
        : null;
      const settled =
        disposition &&
        ['accepted', 'credited', 'written_off'].includes(disposition.response)
          ? (shortage?.quantity ?? 0)
          : 0;
      const providerReceived =
        commitments
          .filter(
            (value) =>
              value.lineId === line.id &&
              value.kind === 'received' &&
              value.status === 'confirmed' &&
              value.source.kind === 'purchasing_system',
          )
          .at(-1)?.quantity ?? 0;
      const expectedQuantity =
        submission.state === 'submitted' && order.status === 'open'
          ? Math.max(0, (lineProgress.confirmed ?? line.quantity) - settled)
          : 0;
      const facts = commitments.filter(
        (value) =>
          value.status === 'confirmed' &&
          (value.lineId === line.id || value.lineId === null),
      );
      const observedAt =
        facts
          .map((value) =>
            value.source.kind === 'purchasing_system'
              ? value.source.observedAt
              : value.recordedAt,
          )
          .sort()
          .at(-1) ??
        submission.submittedAt ??
        submission.updatedAt;
      lines.push({
        lineId: line.id,
        skuId: sku[0]!.id,
        locationId: line.locationId,
        unit: line.unit,
        expectedQuantity: String(expectedQuantity),
        providerReceivedQuantity: String(providerReceived),
        scopeVersion: scope.version,
        observedAt,
        expectedDate: lineProgress.expectedDate,
        dateConfidence: lineProgress.promisedDate
          ? 'confirmed'
          : lineProgress.requestedDate
            ? 'requested'
            : 'unknown',
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
