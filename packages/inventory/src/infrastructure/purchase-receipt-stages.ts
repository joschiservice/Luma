import {
  requirePermission,
  requireTenant,
  type TenantContext,
} from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type { PurchaseReceiptStage } from '../application/ledger.js';
import { bookingReadsBack } from '../domain/ledger.js';
import { ledgerReceiptSchema } from './ledger-validation.js';

/**
 * Lists where each native stock receipt review of a purchase order stands, for procurement
 * readers who may not see stock: its state and time and, once approved and posted, whether the
 * booking reads back from the ledger. The reviews' quantities, accounts, locations, people,
 * reasons and provider IDs never leave this query.
 *
 * The caller passes a freshly authorized context; the query requires `procurement.read` and
 * reads only that tenant's reviews of this order, the newest 100 like Inventory's own review
 * list, in one read-only snapshot. The readback compares the stored receipt with the current
 * native ledger accounts, the same rule as `verifyPurchaseReceipt`; it reads no provider, so
 * listing stages never triggers a provider read on behalf of the reader.
 */
export function createPurchaseReceiptStages(
  db: TenantDatabase,
  now: () => Date = () => new Date(),
) {
  return async (
    context: TenantContext,
    purchaseOrderId: string,
  ): Promise<PurchaseReceiptStage[]> => {
    requireTenant(context, context.tenantId);
    requirePermission(context, 'procurement.read');

    return db.transaction(
      context.tenantId,
      async (tx) => {
        const reviews = (
          await tx.query<{
            id: string;
            state: PurchaseReceiptStage['state'];
            at: Date;
            receipt: unknown;
          }>(
            `SELECT r.id::text,r.state,COALESCE(r.reviewed_at,r.created_at) AS at,
              CASE WHEN r.state='approved' THEN c.receipt END AS receipt
             FROM inventory_ledger_reviews r
             LEFT JOIN inventory_ledger_commands c ON c.tenant_id=r.tenant_id
              AND c.command_key=r.command_key AND c.command_hash=r.command_hash
             WHERE r.tenant_id=$1 AND r.command_document ? 'purchaseReceipt'
              AND r.command_document->'purchaseReceipt'->>'purchaseOrderId'=$2
             ORDER BY r.created_at DESC LIMIT 100`,
            [context.tenantId, purchaseOrderId],
          )
        ).rows.map((row) => ({
          ...row,
          receipt: row.receipt ? ledgerReceiptSchema.parse(row.receipt) : null,
        }));
        const accountIds = reviews.flatMap(
          (review) => review.receipt?.accounts.map((a) => a.id) ?? [],
        );
        const current = accountIds.length
          ? (
              await tx.query<{ id: string; balance: string; version: string }>(
                `SELECT id::text,trim_scale(balance)::text AS balance,version::text AS version
                 FROM inventory_ledger_accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
                [context.tenantId, [...new Set(accountIds)]],
              )
            ).rows
          : [];
        const observedAt = now().toISOString();

        return reviews.map(
          ({ id, state, at, receipt }): PurchaseReceiptStage => {
            const posted = receipt?.accounts.map((a) => a.id) ?? [];

            return {
              reviewId: id,
              state,
              at: at.toISOString(),
              verification: receipt
                ? {
                    outcome: bookingReadsBack(
                      receipt,
                      current.filter((account) => posted.includes(account.id)),
                    )
                      ? 'verified'
                      : 'inconclusive',
                    observedAt,
                  }
                : null,
            };
          },
        );
      },
      { readOnlySnapshot: true },
    );
  };
}
