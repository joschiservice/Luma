import type { TenantContext } from '@luma/identity';
import { conflict, notFound, unavailable } from '@luma/platform';

import {
  lastConfirmed,
  manualReceiptError,
} from '../domain/supplier-responses.js';
import type { CommitmentContext } from './commitment-context.js';

/** Manual receipts and receipt differences for orders no purchasing system reports on. */
export function createReceipts({
  deps,
  authorize,
  audit,
  command,
  incomingResult,
}: CommitmentContext) {
  return {
    /** Records cumulative manual receipts or differences without changing provider evidence. */
    async recordReceipt(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      if (
        !deps.parse.receipt ||
        !(await deps.reconciliationAvailable?.(context))
      )
        throw unavailable(
          'Receipt reconciliation is not enabled for this workspace.',
        );
      const request = deps.parse.receipt(input);

      return incomingResult(
        context,
        orderId,
        command(
          context,
          request.id,
          { command: 'receipt', orderId, ...request },
          async (tx) => {
            const order = await tx.order(orderId);
            if (!order) throw notFound('Purchase order not found');
            const supplier = await tx.supplier(order.supplierId);
            const submissions = await tx.submissions([orderId]);
            const commitments = await tx.commitments([orderId]);
            const error = manualReceiptError({
              order,
              request,
              now: deps.now().getTime(),
              purchasingSystemOwned:
                !!supplier?.link ||
                submissions.some((s) => s.channel !== 'email'),
              commitments,
            });
            if (error) throw conflict(error);
            const latest = lastConfirmed(
              commitments,
              request.lineId,
              request.kind,
            );
            const damaged = lastConfirmed(
              commitments,
              request.lineId,
              'damaged',
            );
            const commitment = await tx.insertCommitment(
              {
                id: request.id,
                tenantId: context.tenantId,
                purchaseOrderId: orderId,
                lineId: request.lineId,
                kind: request.kind,
                quantity: request.quantity,
                date: null,
                text: null,
                source: {
                  kind: 'manual_receipt',
                  receivedAt: request.receivedAt,
                  condition: request.condition,
                  reason: request.reason,
                  evidence: request.evidence,
                },
                status: 'confirmed',
                reviewReasons: [],
                supersedes: latest?.id ?? null,
                recordedAt: deps.now().toISOString(),
                recordedBy: { kind: 'user', id: context.actor.id },
                review: null,
              },
              `receipt:${request.id}`,
            );
            if (
              request.kind === 'received' &&
              request.damagedQuantity !== undefined
            )
              await tx.insertCommitment(
                {
                  ...commitment,
                  id: deps.uuid(`receipt-damage:${request.id}`),
                  kind: 'damaged',
                  quantity: request.damagedQuantity,
                  supersedes: damaged?.id ?? null,
                },
                `receipt-damage:${request.id}`,
              );
            await tx.audit(
              audit(
                context,
                'purchase_order.receipt_recorded',
                request.id,
                orderId,
                {
                  commitmentId: request.id,
                  kind: request.kind,
                  quantity: String(request.quantity),
                  lineId: request.lineId,
                  reason: request.reason,
                },
                request.evidence,
              ),
            );

            return commitment;
          },
        ),
      );
    },
  };
}
