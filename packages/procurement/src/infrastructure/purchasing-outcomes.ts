import { createHash, randomUUID } from 'node:crypto';

import type { AuditLog } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import { canonicalJson, conflict, type TenantDatabase } from '@luma/platform';

import type { createPurchasingOutcomes } from '../application/purchasing-outcomes.js';
import type {
  PurchasingPlan,
  PurchasingRecommendation,
} from '../domain/purchasing.js';
import type { PurchasingOutcome } from '../domain/purchasing-outcomes.js';
import { evaluatePurchasingOutcome } from '../domain/purchasing-outcomes.js';
import {
  purchasingPlanSchema,
  purchasingRecommendationSchema,
} from './purchasing-validation.js';

type OutcomeDependencies = Parameters<typeof createPurchasingOutcomes>[0];

type Candidate = {
  id: string;
  supplierId: string;
  supplierName: string;
  skuId: string;
  sku: string;
  locationId: string;
  unit: string;
  decision: PurchasingOutcome['decision'];
  decidedAt: string;
  suggested: number | null;
  chosen: number | null;
  orderId: string | null;
  lineId: string | null;
  target: number | null;
  sourceConnectionIds: string[] | null;
};

const uuid = (value: string) => {
  const h = createHash('sha256').update(value).digest('hex');

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Reads append-only receipt and stock evidence; imports and manual receipt claims cannot establish stock arrival. */
export function createPurchasingOutcomePersistence(
  db: TenantDatabase,
  audit: (db: TenantDatabase) => AuditLog,
): Pick<OutcomeDependencies, 'read' | 'ignore' | 'existing'> {
  return {
    async existing(context, request) {
      return db.transaction(context.tenantId, async (tx) => {
        const prior = (
          await tx.query<{ request: unknown; actor_id: string }>(
            'SELECT request,actor_id FROM procurement_purchasing_ignored WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, request.id],
          )
        ).rows[0];
        if (!prior) return false;
        if (
          prior.actor_id !== context.actor.id ||
          canonicalJson(prior.request) !== canonicalJson(request)
        )
          throw conflict('This decision ID was already used.');

        return true;
      });
    },
    async ignore(context, request, recommendation) {
      await db.transaction(context.tenantId, async (tx) => {
        const prior = (
          await tx.query<{ request: unknown; actor_id: string }>(
            'SELECT request,actor_id FROM procurement_purchasing_ignored WHERE tenant_id=$1 AND id=$2',
            [context.tenantId, request.id],
          )
        ).rows[0];
        if (prior) {
          if (
            prior.actor_id !== context.actor.id ||
            canonicalJson(prior.request) !== canonicalJson(request)
          )
            throw conflict('This decision ID was already used.');

          return;
        }
        const now = new Date().toISOString();
        const inserted = await tx.query(
          'INSERT INTO procurement_purchasing_ignored(tenant_id,id,actor_id,request,recommendation,decided_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            context.tenantId,
            request.id,
            context.actor.id,
            request,
            recommendation,
            now,
          ],
        );
        if (!inserted.rowCount)
          throw conflict(
            'This decision was recorded concurrently. Retry the same request.',
          );
        await audit({
          transaction: async (_tenant, operation) => operation(tx),
        }).append({
          id: randomUUID(),
          tenantId: context.tenantId,
          eventKey: `purchasing-ignored:${request.id}`,
          eventType: 'procurement.recommendation_ignored',
          schemaVersion: 1,
          occurredAt: now,
          actor: { kind: 'user', id: context.actor.id },
          correlationId: request.id,
          proposalId: request.id,
          actionHash: createHash('sha256')
            .update(canonicalJson(request))
            .digest('hex'),
          evidenceRefs: recommendation.stocks.map((s) => s.observationId),
          details: {
            skuId: request.skuId,
            supplierId: request.supplierId,
            reason: request.reason,
          },
        });
      });
    },
    async read(context: TenantContext) {
      return db.transaction(
        context.tenantId,
        async (tx) => {
          const plans = (
            await tx.query<{ document: unknown; supplier_name: string }>(
              `SELECT p.document,s.document->>'name' AS supplier_name FROM procurement_purchasing_plans p JOIN procurement_suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id WHERE p.tenant_id=$1 ORDER BY p.created_at DESC LIMIT 101`,
              [context.tenantId],
            )
          ).rows;
          const ignored = (
            await tx.query<{
              id: string;
              recommendation: unknown;
              decided_at: Date;
            }>(
              `SELECT id,recommendation,decided_at FROM procurement_purchasing_ignored WHERE tenant_id=$1 ORDER BY decided_at DESC LIMIT 101`,
              [context.tenantId],
            )
          ).rows;
          const candidates: Candidate[] = [];
          for (const row of plans.slice(0, 100)) {
            const p: PurchasingPlan = purchasingPlanSchema.parse(row.document);
            for (const suggestion of p.suggestions) {
              const line = p.order.lines.find(
                (l) =>
                  l.sku === suggestion.skuId &&
                  l.locationId === suggestion.locationId,
              );
              if (!line) continue;
              candidates.push({
                id: uuid(
                  `${p.id}:${suggestion.skuId}:${suggestion.locationId}`,
                ),
                supplierId: p.supplierId,
                supplierName: row.supplier_name,
                skuId: suggestion.skuId,
                sku: line.description,
                locationId: suggestion.locationId,
                unit: line.unit,
                decision:
                  suggestion.suggested === suggestion.chosen
                    ? 'followed'
                    : 'changed',
                decidedAt: p.createdAt,
                suggested: suggestion.suggested,
                chosen: suggestion.chosen,
                orderId: p.state === 'verified' ? p.order.id : null,
                lineId: line.id,
                target: suggestion.target ?? null,
                sourceConnectionIds: suggestion.sourceConnectionIds ?? null,
              });
            }
          }
          for (const row of ignored.slice(0, 100)) {
            const r: PurchasingRecommendation =
              purchasingRecommendationSchema.parse(row.recommendation);
            for (const stock of r.stocks)
              candidates.push({
                id: uuid(`${row.id}:${stock.locationId}`),
                supplierId: r.supplierId,
                supplierName: r.supplierName,
                skuId: r.skuId,
                sku: r.sku,
                locationId: stock.locationId,
                unit: stock.unit,
                decision: 'ignored',
                decidedAt: row.decided_at.toISOString(),
                suggested: r.quantity,
                chosen: null,
                orderId: null,
                lineId: null,
                target: r.rule?.target ?? null,
                sourceConnectionIds: [
                  ...new Set(
                    r.stocks
                      .filter((s) => s.locationId === stock.locationId)
                      .map((s) => s.connectionId),
                  ),
                ],
              });
          }

          const selected = candidates.slice(0, 250);
          const targets = JSON.stringify(
            selected.map((c) => ({
              skuId: c.skuId,
              locationId: c.locationId,
              unit: c.unit,
              decidedAt: c.decidedAt,
            })),
          );
          const orders = [
            ...new Set(selected.flatMap((c) => (c.orderId ? [c.orderId] : []))),
          ];

          type StockRow = {
            sku_id: string;
            location_id: string;
            unit: string;
            connection_id: string;
            observation_id: string;
            observed_at: Date;
            available: string | null;
            complete: boolean;
          };

          // Read each evidence source once. A global cap makes truncated histories explicitly unknown.
          const providerStocks = (
            await tx.query<StockRow>(
              `
            WITH targets AS (SELECT "skuId","locationId",unit,min("decidedAt"::timestamptz) AS since FROM jsonb_to_recordset($2::jsonb) AS t("skuId" uuid,"locationId" uuid,unit text,"decidedAt" text) GROUP BY 1,2,3)
            SELECT s.sku_id,s.document->'data'->>'locationId' AS location_id,s.document->'data'->>'unit' AS unit,s.connection_id,s.observation_id,s.observed_at,s.document->'data'->>'available' AS available,NOT COALESCE((s.document->>'deleted')::boolean,true) AS complete
            FROM inventory_snapshots s JOIN targets t ON t."skuId"=s.sku_id AND t."locationId"::text=s.document->'data'->>'locationId' AND t.unit=s.document->'data'->>'unit'
            WHERE s.tenant_id=$1 AND s.kind='position' AND s.observed_at>=t.since AND s.observed_at<=now() ORDER BY s.observed_at DESC,s.id LIMIT 10001`,
              [context.tenantId, targets],
            )
          ).rows;

          type ReceiptRow = {
            order_id: string;
            line_id: string;
            id: string;
            observed_at: Date;
          };

          const providerReceipts = (
            await tx.query<ReceiptRow>(
              `
            SELECT DISTINCT ON(purchase_order_id,document->>'lineId') purchase_order_id AS order_id,document->>'lineId' AS line_id,id,(document->'source'->>'observedAt')::timestamptz AS observed_at
            FROM procurement_commitments WHERE tenant_id=$1 AND purchase_order_id=ANY($2::uuid[]) AND document->>'kind'='received' AND document->>'status'='confirmed' AND document->'source'->>'kind'='purchasing_system' AND (document->>'quantity')::numeric>0
            ORDER BY purchase_order_id,document->>'lineId',(document->'source'->>'observedAt')::timestamptz LIMIT 251`,
              [context.tenantId, orders],
            )
          ).rows;
          const shopifyReceipts = (
            await tx.query<
              ReceiptRow & {
                available: string;
                connection_id: string;
                sku_id: string;
                location_id: string;
                unit: string;
              }
            >(
              `
            SELECT r.document->'target'->'receipt'->>'purchaseOrderId' AS order_id,r.document->'target'->'receipt'->>'lineId' AS line_id,e.id,e.observed_at,e.document->>'available' AS available,r.connection_id,s.sku_id,s.document->'data'->>'locationId' AS location_id,s.document->'data'->>'unit' AS unit
            FROM shopify_inventory_corrections r JOIN executed_actions x ON x.tenant_id=r.tenant_id AND x.proposal_id=r.id
            JOIN shopify_inventory_evidence e ON e.tenant_id=r.tenant_id AND e.connection_id=r.connection_id AND e.id::text IN (SELECT jsonb_array_elements_text(x.document->'attempt'->'verification'->'observationRefs'))
            JOIN inventory_projections p ON p.tenant_id=r.tenant_id AND p.entity_id=r.position_id AND p.connection_id=r.connection_id
            JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
            WHERE r.tenant_id=$1 AND r.document->'target'->'receipt'->>'purchaseOrderId'=ANY($2::text[]) AND x.document->'attempt'->>'businessOutcome'='satisfied' AND e.kind='observation' AND e.document->>'complete'='true' AND e.document->>'available'=r.document->'before'->'source'->>'available'
            ORDER BY e.observed_at LIMIT 251`,
              [context.tenantId, orders],
            )
          ).rows;
          const nativeReceipts = (
            await tx.query<ReceiptRow>(
              `SELECT b.purchase_order_id AS order_id,b.line_id,b.entry_id AS id,b.recorded_at AS observed_at FROM inventory_purchase_receipt_bookings b JOIN inventory_ledger_entries e ON e.tenant_id=b.tenant_id AND e.id=b.entry_id WHERE b.tenant_id=$1 AND b.purchase_order_id=ANY($2::uuid[]) AND b.good>0 AND e.purpose='purchase_receipt' AND e.review_id IS NOT NULL ORDER BY b.recorded_at LIMIT 251`,
              [context.tenantId, orders],
            )
          ).rows;
          const nativeCurrent = (
            await tx.query<StockRow>(
              `
            SELECT a.sku_id,a.location_id,a.unit,'native' AS connection_id,a.id AS observation_id,clock_timestamp() AS observed_at,trim_scale(a.balance)::text AS available,true AS complete FROM inventory_ledger_accounts a
            WHERE a.tenant_id=$1 AND a.state='available' AND EXISTS(SELECT 1 FROM inventory_stock_ownership_scopes o WHERE o.tenant_id=a.tenant_id AND o.location_id=a.location_id AND o.mode='own')
            AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS t("skuId" uuid,"locationId" uuid) WHERE t."skuId"=a.sku_id AND t."locationId"=a.location_id) LIMIT 251`,
              [context.tenantId, targets],
            )
          ).rows;
          const nativeHistory = (
            await tx.query<StockRow>(
              `
            WITH targets AS (SELECT "skuId","locationId",unit,min("decidedAt"::timestamptz) AS since FROM jsonb_to_recordset($2::jsonb) AS t("skuId" uuid,"locationId" uuid,unit text,"decidedAt" text) GROUP BY 1,2,3)
            SELECT a.sku_id,a.location_id,a.unit,'native' AS connection_id,e.id AS observation_id,e.recorded_at AS observed_at,trim_scale(p.balance_after)::text AS available,true AS complete FROM inventory_ledger_postings p JOIN inventory_ledger_accounts a ON a.tenant_id=p.tenant_id AND a.id=p.account_id JOIN inventory_ledger_entries e ON e.tenant_id=p.tenant_id AND e.id=p.entry_id JOIN targets t ON t."skuId"=a.sku_id AND t."locationId"=a.location_id AND t.unit=a.unit
            WHERE p.tenant_id=$1 AND a.state='available' AND e.recorded_at>=t.since AND EXISTS(SELECT 1 FROM inventory_stock_ownership_scopes o WHERE o.tenant_id=a.tenant_id AND o.location_id=a.location_id AND o.mode='own') ORDER BY e.recorded_at DESC,e.id LIMIT 10001`,
              [context.tenantId, targets],
            )
          ).rows;
          const historyTruncated =
            providerStocks.length > 10000 || nativeHistory.length > 10000;
          const truncated =
            plans.length > 100 ||
            ignored.length > 100 ||
            candidates.length > 250 ||
            historyTruncated ||
            providerReceipts.length > 250 ||
            shopifyReceipts.length > 250 ||
            nativeReceipts.length > 250;
          const items: PurchasingOutcome[] = selected.map((c) => {
            const matches = (r: StockRow) =>
              r.sku_id === c.skuId &&
              r.location_id === c.locationId &&
              r.unit === c.unit &&
              r.observed_at.toISOString() >= c.decidedAt;
            const native = nativeCurrent.filter(matches);
            const rows = native.length
              ? [...nativeHistory.slice(0, 10000).filter(matches), ...native]
              : providerStocks
                  .slice(0, 10000)
                  .filter(
                    (r) =>
                      matches(r) &&
                      (!c.sourceConnectionIds ||
                        c.sourceConnectionIds.includes(r.connection_id)),
                  );
            const corrections = shopifyReceipts.filter(
              (r) => r.order_id === c.orderId && r.line_id === c.lineId,
            );
            if (!native.length)
              rows.push(
                ...corrections.map((r) => ({
                  ...r,
                  observation_id: r.id,
                  complete: true,
                })),
              );
            const sourceCount = new Set(rows.map((r) => r.connection_id)).size;
            const stocks = rows.map((r) => ({
              observationId: r.observation_id,
              observedAt: r.observed_at.toISOString(),
              available:
                r.available !== null && Number.isFinite(Number(r.available))
                  ? Number(r.available)
                  : null,
              complete: r.complete && sourceCount === 1 && !historyTruncated,
            }));
            const received = (
              native.length
                ? nativeReceipts
                : [...providerReceipts, ...corrections]
            )
              .filter((r) => r.order_id === c.orderId && r.line_id === c.lineId)
              .sort(
                (a, b) => a.observed_at.getTime() - b.observed_at.getTime(),
              )[0];
            const receipt = received
              ? {
                  observedAt: received.observed_at.toISOString(),
                  verified: true,
                  evidenceRefs: [received.id],
                }
              : null;

            return {
              ...c,
              ...evaluatePurchasingOutcome({
                decidedAt: c.decidedAt,
                decision: c.decision,
                stocks,
                receipt,
                target: c.target,
                now: Date.now(),
              }),
            };
          });

          return {
            items,
            summary: {
              verifiedAvailable: items.filter(
                (i) => i.state === 'available_through_receipt',
              ).length,
              stockouts: items.filter((i) => i.state === 'stockout_observed')
                .length,
              unknown: items.filter((i) => i.state === 'unknown').length,
            },
            truncated,
            asOf: new Date().toISOString(),
          };
        },
        { readOnlySnapshot: true },
      );
    },
  };
}
