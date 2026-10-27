import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  Commitment,
  FollowUp,
  Submission,
} from '../domain/commitments.js';
import {
  arrivalStatus,
  type IncomingItem,
  type IncomingStock,
  supplierIncoming,
} from '../domain/incoming.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { readWorkspaceTimeZone } from './workspace-time-zone.js';

type TransferDocument = {
  observedAt: string;
  observationId: string;
  data: {
    type: string;
    expectedArrivalAt: string | null;
    lines:
      | {
          skuId: string | null;
          unreceived: string;
          unit: string;
          sourceId: { externalId: string; scopeKey: string };
        }[]
      | null;
  };
};

/** Reads current supplier, transfer and ledger evidence in one bounded tenant snapshot. */
export function createIncomingStockReader(
  db: TenantDatabase,
  now = () => new Date(),
) {
  return (
    context: TenantContext,
    input: { skuIds: string[]; locationId?: string | undefined },
  ): Promise<Omit<IncomingStock, 'enabled'>> =>
    db.transaction(
      context.tenantId,
      async (tx) => {
        const asOf = now();
        const aliasesRows = (
          await tx.query<{ sku_id: string; key: string }>(
            `SELECT e.id AS sku_id,e.reconciliation_key AS key FROM inventory_entities e WHERE e.tenant_id=$1 AND e.kind='sku' AND e.id=ANY($2::uuid[])
      UNION SELECT p.sku_id,p.code AS key FROM inventory_product_skus p WHERE p.tenant_id=$1 AND p.sku_id=ANY($2::uuid[]) AND p.code IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_product_skus other WHERE other.tenant_id=p.tenant_id AND other.code=p.code AND other.sku_id<>p.sku_id)`,
            [context.tenantId, input.skuIds],
          )
        ).rows;
        const aliases = new Map<string, string>(
          input.skuIds.map((id) => [id, id]),
        );
        for (const row of aliasesRows) {
          const matches = aliasesRows.filter((value) => value.key === row.key);
          if (
            new Set(matches.map((value) => value.sku_id)).size === 1 &&
            !aliases.has(row.key)
          )
            aliases.set(row.key, row.sku_id);
        }
        const scopes = (
          await tx.query<{ location_id: string }>(
            `SELECT location_id FROM inventory_stock_ownership_scopes WHERE tenant_id=$1 AND mode='own'`,
            [context.tenantId],
          )
        ).rows;
        const ownedLocations = new Set(scopes.map((row) => row.location_id));
        const locationRows = (
          await tx.query<{ id: string; name: string }>(
            `SELECT id,reconciliation_key AS name FROM inventory_entities WHERE tenant_id=$1 AND kind='location'`,
            [context.tenantId],
          )
        ).rows;
        const locations = new Map(
          locationRows.map((row) => [row.id, row.name]),
        );
        const orders = hasPermission(context, 'procurement.read')
          ? (
              await tx.query<{ document: PurchaseOrder }>(
                `SELECT document FROM procurement_purchase_orders WHERE tenant_id=$1 AND document->>'status'='open' AND EXISTS(SELECT 1 FROM jsonb_array_elements(document->'lines') line WHERE line->>'sku'=ANY($2::text[])) ORDER BY created_at DESC,id LIMIT 1001`,
                [context.tenantId, [...aliases.keys()]],
              )
            ).rows.map((row) => row.document)
          : [];
        const ids = orders.slice(0, 1000).map((order) => order.id);
        // One connection owns this snapshot transaction, so issue its queries sequentially.
        const commitments = ids.length
          ? await tx.query<{ document: Commitment }>(
              'SELECT document FROM procurement_commitments WHERE tenant_id=$1 AND purchase_order_id=ANY($2::uuid[]) ORDER BY recorded_at,id',
              [context.tenantId, ids],
            )
          : { rows: [] };
        const followUps = ids.length
          ? await tx.query<{ document: FollowUp }>(
              'SELECT document FROM procurement_follow_ups WHERE tenant_id=$1 AND purchase_order_id=ANY($2::uuid[]) ORDER BY responded_at,id',
              [context.tenantId, ids],
            )
          : { rows: [] };
        const submissions = ids.length
          ? await tx.query<{ document: Submission }>(
              'SELECT document FROM procurement_submissions WHERE tenant_id=$1 AND purchase_order_id=ANY($2::uuid[]) ORDER BY created_at DESC,id',
              [context.tenantId, ids],
            )
          : { rows: [] };
        const timeZone = await readWorkspaceTimeZone(tx, context.tenantId);
        const items: IncomingItem[] = orders.slice(0, 1000).flatMap((order) =>
          supplierIncoming({
            order,
            submission:
              submissions.rows.find(
                (row) => row.document.purchaseOrderId === order.id,
              )?.document ?? null,
            commitments: commitments.rows
              .filter((row) => row.document.purchaseOrderId === order.id)
              .map((row) => row.document),
            followUps: followUps.rows
              .filter((row) => row.document.purchaseOrderId === order.id)
              .map((row) => row.document),
            aliases,
            locations,
            ownedLocations,
            now: asOf,
            timeZone,
          }),
        );
        const shipments = (
          await tx.query<{
            transfer_id: string;
            location_id: string | null;
            transfer_name: string;
            document: TransferDocument;
          }>(
            `SELECT DISTINCT t.entity_id AS transfer_id,ts.document->'data'->'destination'->>'locationId' AS location_id,t.name AS transfer_name,s.document
      FROM inventory_transfer_records t JOIN inventory_snapshots ts ON ts.tenant_id=t.tenant_id AND ts.id=t.snapshot_id
      JOIN inventory_transfer_shipments link ON link.tenant_id=t.tenant_id AND link.entity_id=t.entity_id AND link.connection_id=t.connection_id
      JOIN connector_source_mappings m ON m.tenant_id=link.tenant_id AND m.connection_id=link.connection_id AND m.resource='inventory_shipment' AND m.external_id=link.shipment_source_id AND m.scope_key=link.shipment_scope_key
      JOIN inventory_transfer_records r ON r.tenant_id=m.tenant_id AND r.entity_id=m.canonical_id AND r.connection_id=m.connection_id AND r.kind='inventory_shipment'
      JOIN inventory_snapshots s ON s.tenant_id=r.tenant_id AND s.id=r.snapshot_id
      JOIN connector_installations c ON c.tenant_id=t.tenant_id AND c.id=t.connection_id
      WHERE t.tenant_id=$1 AND t.kind='inventory_transfer' AND NOT t.deleted AND NOT r.deleted AND t.status NOT IN ('draft','unknown','cancelled','received')
      AND r.status IN ('in_transit','partially_received') AND (r.facts->>'complete')::boolean AND (r.facts->>'consistent')::boolean
      AND c.document->>'status'='active' AND c.document->'permissions' ? 'inventory.transfers.read' AND c.document->'granted' ? 'inventory.transfers.read'
      AND c.document->'permissions' ? 'inventory.shipments.read' AND c.document->'granted' ? 'inventory.shipments.read'
      AND EXISTS(SELECT 1 FROM inventory_transfer_references ref WHERE ref.tenant_id=r.tenant_id AND ref.entity_id=r.entity_id AND ref.connection_id=r.connection_id AND ref.resource='sku' AND ref.canonical_id=ANY($2::uuid[]))
      ORDER BY t.entity_id LIMIT 1001`,
            [context.tenantId, input.skuIds],
          )
        ).rows;
        for (const row of shipments.slice(0, 1000)) {
          const data = row.document.data;
          if (
            data.type !== 'inventory_shipment' ||
            (row.location_id && ownedLocations.has(row.location_id))
          )
            continue;
          for (const line of data.lines ?? []) {
            if (!line.skuId || !input.skuIds.includes(line.skuId)) continue;
            const quantity = Number(line.unreceived);
            if (!Number.isFinite(quantity) || quantity <= 0) continue;
            const age = asOf.getTime() - Date.parse(row.document.observedAt);
            items.push({
              key: `transfer:${row.transfer_id}:${row.document.observationId}:${line.sourceId.externalId}`,
              source: 'transfer',
              skuId: line.skuId,
              locationId: row.location_id,
              location: row.location_id
                ? (locations.get(row.location_id) ?? null)
                : null,
              quantity,
              unit: line.unit,
              expectedDate: data.expectedArrivalAt,
              dateStatus: arrivalStatus(data.expectedArrivalAt, asOf),
              orderId: null,
              orderReference: row.transfer_name,
              supplierId: null,
              supplierName: null,
              transferId: row.transfer_id,
              observedAt: row.document.observedAt,
              freshness: age >= 0 && age <= 300_000 ? 'fresh' : 'stale',
              evidenceRefs: [row.document.observationId],
            });
          }
        }
        const accounts = (
          await tx.query<{
            id: string;
            sku_id: string;
            location_id: string;
            unit: string;
            quantity: string;
            entry_id: string | null;
          }>(
            `SELECT a.id,a.sku_id,a.location_id,a.unit,a.balance::text AS quantity,p.entry_id FROM inventory_ledger_accounts a JOIN inventory_stock_ownership_scopes scope ON scope.tenant_id=a.tenant_id AND scope.location_id=a.location_id AND scope.mode='own' LEFT JOIN inventory_ledger_postings p ON p.tenant_id=a.tenant_id AND p.account_id=a.id AND p.account_version=a.version WHERE a.tenant_id=$1 AND a.sku_id=ANY($2::uuid[]) AND a.state='incoming' AND a.balance>0 ORDER BY a.id LIMIT 1001`,
            [context.tenantId, input.skuIds],
          )
        ).rows;
        const nativeRows = hasPermission(context, 'procurement.read')
          ? (
              await tx.query<{
                purchase_order_id: string;
                line_id: string;
                sku_id: string;
                location_id: string;
                unit: string;
                quantity: string;
                observed_at: Date;
                expected_date: string | null;
                date_confidence: 'confirmed' | 'requested' | 'unknown';
                entry_id: string | null;
                source_refs: string[];
                reference: string;
                supplier_id: string;
                supplier_name: string;
                status: string;
              }>(
                `SELECT r.purchase_order_id,r.line_id,r.sku_id,r.location_id,r.unit,trim_scale(r.outstanding_quantity)::text AS quantity,r.observed_at,r.expected_date::text,r.date_confidence,r.entry_id,r.source_refs,o.document->>'reference' AS reference,o.supplier_id,s.document->>'name' AS supplier_name,o.document->>'status' AS status
          FROM inventory_purchase_incoming r JOIN inventory_stock_ownership_scopes scope ON scope.tenant_id=r.tenant_id AND scope.location_id=r.location_id AND scope.mode='own' AND scope.version=r.scope_version
          JOIN procurement_purchase_orders o ON o.tenant_id=r.tenant_id AND o.id=r.purchase_order_id JOIN procurement_suppliers s ON s.tenant_id=o.tenant_id AND s.id=o.supplier_id
          WHERE r.tenant_id=$1 AND r.sku_id=ANY($2::uuid[]) AND (r.outstanding_quantity>0 OR o.document->>'status'='open') ORDER BY r.updated_at DESC,r.purchase_order_id,r.line_id LIMIT 1001`,
                [context.tenantId, input.skuIds],
              )
            ).rows
          : [];
        let unavailableNativeIncoming = orders.some((order) =>
          order.lines.some((line) => {
            const skuId = aliases.get(line.sku);

            return (
              !!skuId &&
              !!line.locationId &&
              ownedLocations.has(line.locationId) &&
              !nativeRows.some(
                (row) =>
                  row.purchase_order_id === order.id && row.line_id === line.id,
              )
            );
          }),
        );
        for (const row of accounts.slice(0, 1000)) {
          const tracked = nativeRows.filter(
            (value) =>
              value.sku_id === row.sku_id &&
              value.location_id === row.location_id &&
              value.unit === row.unit,
          );
          const trackedQuantity = tracked.reduce(
            (sum, value) => sum + Number(value.quantity),
            0,
          );
          const quantity = Number(row.quantity);
          if (
            !Number.isSafeInteger(quantity * 1_000_000) ||
            trackedQuantity > quantity + 1e-6
          ) {
            unavailableNativeIncoming = true;
            continue;
          }
          for (const value of tracked.filter(
            (value) => Number(value.quantity) > 0,
          )) {
            if (value.status !== 'open') {
              unavailableNativeIncoming = true;
              continue;
            }
            const observedAt = value.observed_at.toISOString();
            const age = asOf.getTime() - value.observed_at.getTime();
            items.push({
              key: `ledger:${row.id}:${value.purchase_order_id}:${value.line_id}`,
              source: 'ledger',
              skuId: row.sku_id,
              locationId: row.location_id,
              location: locations.get(row.location_id) ?? null,
              quantity: Number(value.quantity),
              unit: row.unit,
              expectedDate: value.expected_date,
              dateStatus:
                arrivalStatus(value.expected_date, asOf) === 'overdue'
                  ? 'overdue'
                  : value.date_confidence,
              orderId: value.purchase_order_id,
              orderReference: value.reference,
              supplierId: value.supplier_id,
              supplierName: value.supplier_name,
              transferId: null,
              observedAt,
              freshness: age >= 0 && age <= 86400000 ? 'fresh' : 'stale',
              evidenceRefs: [
                row.id,
                ...(value.entry_id ? [value.entry_id] : []),
                ...value.source_refs,
              ],
            });
          }
          const remainder = quantity - trackedQuantity;
          if (remainder > 1e-6)
            items.push({
              key: `ledger:${row.id}`,
              source: 'ledger',
              skuId: row.sku_id,
              locationId: row.location_id,
              location: locations.get(row.location_id) ?? null,
              quantity: remainder,
              unit: row.unit,
              expectedDate: null,
              dateStatus: 'unknown',
              orderId: null,
              orderReference: null,
              supplierId: null,
              supplierName: null,
              transferId: null,
              observedAt: asOf.toISOString(),
              freshness: 'fresh',
              evidenceRefs: [row.id, ...(row.entry_id ? [row.entry_id] : [])],
            });
        }

        return {
          items: items.filter(
            (item) => !input.locationId || item.locationId === input.locationId,
          ),
          truncated:
            orders.length > 1000 ||
            shipments.length > 1000 ||
            accounts.length > 1000 ||
            nativeRows.length > 1000,
          unavailableNativeIncoming,
          supplierOrdersUnavailable: !hasPermission(
            context,
            'procurement.read',
          ),
          asOf: asOf.toISOString(),
        };
      },
      { readOnlySnapshot: true },
    );
}
