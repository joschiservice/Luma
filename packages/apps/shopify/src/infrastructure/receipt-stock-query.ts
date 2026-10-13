import { createHash } from 'node:crypto';

import type { AuthorityReader } from '@luma/connections';
import {
  IdentityError,
  requirePermission,
  type TenantContext,
} from '@luma/identity';
import { canonicalJson, type TenantDatabase } from '@luma/platform';
import { z } from 'zod';

import { receiptStockBindingSchema } from '../domain/inventory-correction.js';

type ReceiptBinding = z.infer<typeof receiptStockBindingSchema>;

const factSchema = z.object({
  id: z.string().uuid(),
  lineId: z.string().uuid().nullable(),
  kind: z.string(),
  quantity: z.number().nullable(),
  status: z.string(),
  source: z.object({ kind: z.string() }),
});

/** Reads procurement receipt evidence through a deliberate cross-owner adapter; this adapter never changes stock or receipts. */
export function createReceiptStockQuery(
  database: TenantDatabase,
  sourceAuthority: AuthorityReader | undefined,
  released: (tenantId: string) => Promise<boolean>,
) {
  async function evidence(
    context: TenantContext,
    purchaseOrderId: string,
    lineId: string,
    excludeBinding?: ReceiptBinding,
    proofBinding?: ReceiptBinding,
  ) {
    requirePermission(context, 'procurement.read');
    if (!(await released(context.tenantId)))
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Receipt stock booking is not enabled.',
      );
    const authority = await sourceAuthority?.read(context);
    const group = authority?.groups.find(
      (value) => value.group === 'inventory_stock',
    );
    if (!authority || !group?.connectionId)
      throw new IdentityError(
        409,
        'CONFLICT',
        'Select the system that owns stock before booking this receipt.',
      );
    const stockConnectionId = group.connectionId;

    return database.transaction(context.tenantId, async (tx) => {
      const order = (
        await tx.query<{ document: unknown }>(
          `SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND id=$2`,
          [context.tenantId, purchaseOrderId],
        )
      ).rows[0]?.document;
      const parsed = z
        .object({
          authority: z.literal('luma'),
          status: z.enum(['open', 'closed']),
          supplierId: z.string().uuid(),
          lines: z.array(
            z.object({
              id: z.string().uuid(),
              sku: z.string(),
              unit: z.string(),
              locationId: z.string().uuid().optional(),
            }),
          ),
        })
        .safeParse(order);
      const line = parsed.success
        ? parsed.data.lines.find((value) => value.id === lineId)
        : undefined;
      if (!line?.locationId || line.unit !== 'each')
        throw new IdentityError(
          409,
          'CONFLICT',
          'This receipt needs an exact receiving location and whole-unit stock.',
        );
      const purchasingSystem = (
        await tx.query(
          `SELECT 1 FROM procurement_suppliers s WHERE s.tenant_id=$1 AND s.id=$2 AND s.document->'link' IS NOT NULL AND s.document->'link'<>'null'::jsonb UNION SELECT 1 FROM procurement_submissions s WHERE s.tenant_id=$1 AND s.purchase_order_id=$3 AND COALESCE(s.document->>'channel','purchasing_system')<>'email' LIMIT 1`,
          [
            context.tenantId,
            parsed.success ? parsed.data.supplierId : null,
            purchaseOrderId,
          ],
        )
      ).rows.length;
      if (purchasingSystem)
        throw new IdentityError(
          409,
          'CONFLICT',
          'The purchasing system books its own receipts.',
        );
      const owned = (
        await tx.query(
          `SELECT 1 FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND location_id=$2 AND mode='own'`,
          [context.tenantId, line.locationId],
        )
      ).rows.length;
      if (owned)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Inventory owns this location. Book this receipt through the native stock ledger.',
        );
      const facts = z
        .array(factSchema)
        .parse(
          (
            await tx.query<{ document: unknown }>(
              'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY recorded_at,id',
              [context.tenantId, purchaseOrderId],
            )
          ).rows.map((row) => row.document),
        );
      const receipt = proofBinding
        ? facts.find(
            (value) =>
              value.id === proofBinding.commitmentId &&
              value.lineId === lineId &&
              value.kind === 'received' &&
              value.status === 'confirmed',
          )
        : facts
            .filter(
              (value) =>
                value.lineId === lineId &&
                value.kind === 'received' &&
                value.status === 'confirmed',
            )
            .at(-1);
      const damaged = proofBinding
        ? facts.find(
            (value) =>
              value.id === proofBinding.damagedCommitmentId &&
              value.lineId === lineId &&
              value.kind === 'damaged' &&
              value.status === 'confirmed',
          )
        : facts
            .filter(
              (value) =>
                value.lineId === lineId &&
                value.kind === 'damaged' &&
                value.status === 'confirmed',
            )
            .at(-1);
      if (proofBinding?.damagedCommitmentId && !damaged)
        throw new IdentityError(
          409,
          'CONFLICT',
          'The approved damaged receipt evidence was not found.',
        );
      if (!receipt || receipt.source.kind !== 'manual_receipt')
        throw new IdentityError(
          409,
          'CONFLICT',
          'Record a manual receipt before proposing stock booking.',
        );
      const cumulativeGood = (receipt.quantity ?? 0) - (damaged?.quantity ?? 0);
      if (!Number.isSafeInteger(cumulativeGood) || cumulativeGood <= 0)
        throw new IdentityError(
          409,
          'CONFLICT',
          'This receipt has no whole, undamaged units to book.',
        );
      const prior = (
        await tx.query<{
          receipt_id: string;
          damaged_id: string | null;
          good: number;
          state: string | null;
          dispatch: string | null;
        }>(
          `SELECT r.document->'target'->'receipt'->>'commitmentId' AS receipt_id,r.document->'target'->'receipt'->>'damagedCommitmentId' AS damaged_id,(r.document->'target'->'receipt'->>'cumulativeGood')::int AS good,e.state,e.document->'attempt'->>'dispatch' AS dispatch
        FROM shopify_inventory_corrections r JOIN shopify_receipt_stock_claims c ON c.tenant_id=r.tenant_id AND c.run_id=r.id
        LEFT JOIN executed_actions e ON e.tenant_id=r.tenant_id AND e.proposal_id=r.id
        WHERE r.tenant_id=$1 AND NOT c.withheld AND r.document->'target'->'receipt'->>'purchaseOrderId'=$2 AND r.document->'target'->'receipt'->>'lineId'=$3`,
          [context.tenantId, purchaseOrderId, lineId],
        )
      ).rows.filter(
        (row) =>
          !excludeBinding ||
          row.receipt_id !== excludeBinding.commitmentId ||
          row.damaged_id !== excludeBinding.damagedCommitmentId,
      );
      if (
        !proofBinding &&
        prior.some(
          (row) =>
            row.state !== 'succeeded' && row.dispatch !== 'not_dispatched',
        )
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Check the previous receipt stock booking before proposing more stock.',
        );
      const previouslyBooked = Math.max(
        0,
        ...prior
          .filter((row) => row.state === 'succeeded')
          .map((row) => row.good),
      );
      const positions = (
        await tx.query<{
          position_id: string;
          sku_id: string;
          location_id: string;
        }>(
          `SELECT p.entity_id AS position_id,s.document->'data'->>'skuId' AS sku_id,s.document->'data'->>'locationId' AS location_id
        FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
        JOIN connector_installations c ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
        WHERE p.tenant_id=$1 AND p.connection_id=$2 AND s.kind='position' AND s.document->'data'->>'locationId'=$3 AND c.document->>'provider'='shopify'
        AND ((s.document->'data'->>'skuId')=$4 OR EXISTS(SELECT 1 FROM inventory_entities e WHERE e.tenant_id=p.tenant_id AND e.id=(s.document->'data'->>'skuId')::uuid AND e.reconciliation_key=$4)
          OR EXISTS(SELECT 1 FROM inventory_product_skus ps WHERE ps.tenant_id=p.tenant_id AND ps.sku_id=(s.document->'data'->>'skuId')::uuid AND ps.code=$4))
        GROUP BY p.entity_id,s.document->'data'->>'skuId',s.document->'data'->>'locationId' LIMIT 2`,
          [context.tenantId, stockConnectionId, line.locationId, line.sku],
        )
      ).rows;
      if (positions.length !== 1)
        throw new IdentityError(
          409,
          'CONFLICT',
          'Map this receipt to exactly one Shopify stock position.',
        );

      return {
        receiptId: receipt.id,
        damagedId: damaged?.id ?? null,
        cumulativeGood,
        previouslyBooked,
        quantity: proofBinding?.quantity ?? cumulativeGood - previouslyBooked,
        connectionId: stockConnectionId,
        positionId: positions[0]!.position_id,
        authorityRevision: authority.revision,
      };
    });
  }

  return {
    evidence,
    /** Revalidates the exact receipt, damage, cumulative booking and workspace authority captured in an approved intent. */
    async source(
      context: TenantContext,
      binding: ReceiptBinding,
      connectionId: string,
      positionId: string,
      proof = false,
    ) {
      const current = await evidence(
        context,
        binding.purchaseOrderId,
        binding.lineId,
        binding,
        proof ? binding : undefined,
      );
      if (
        current.receiptId !== binding.commitmentId ||
        current.damagedId !== binding.damagedCommitmentId ||
        current.cumulativeGood !== binding.cumulativeGood ||
        current.quantity !== binding.quantity ||
        current.connectionId !== connectionId ||
        current.positionId !== positionId
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'Receipt, previous bookings, mappings or stock authority changed. Review again.',
        );
      const available = binding.baselineAvailable + binding.quantity;
      if (
        !Number.isSafeInteger(available) ||
        available < 0 ||
        available > 2147483647
      )
        throw new IdentityError(
          409,
          'CONFLICT',
          'The resulting Shopify quantity must be a supported whole number.',
        );

      return {
        connectionId,
        label: 'Manual purchase receipt',
        observationId: binding.commitmentId,
        observedAt: new Date().toISOString(),
        available,
        revision: createHash('sha256')
          .update(
            canonicalJson({
              binding,
              authorityRevision: current.authorityRevision,
            }),
          )
          .digest('hex'),
        receipt: binding,
      };
    },
  };
}
