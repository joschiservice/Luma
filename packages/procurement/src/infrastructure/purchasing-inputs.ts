import type { AuthorityReader } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import type {
  PurchasingDemand,
  PurchasingSettings,
  PurchasingStock,
} from '../domain/purchasing.js';

type StockDocument = {
  observedAt: string;
  observationId: string;
  deleted: boolean;
  data: {
    skuId: string;
    locationId: string;
    unit: string;
    available: string | null;
    reserved: string | null;
  };
};

type OrderDocument = {
  observedAt: string;
  observationId: string;
  deleted: boolean;
  data: {
    status: string;
    placedAt: string | null;
    lines: {
      skuId: string | null;
      quantity: string;
      cancelledQuantity: string | null;
    }[];
  };
};

const number = (value: string | null | undefined) =>
  value != null && value.trim() !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

/** Reads bounded purchasing evidence from owner projections using explicit source authority. */
export function createPurchasingInputs(
  db: TenantDatabase,
  authority: AuthorityReader,
) {
  return async (
    context: TenantContext,
    skuIds: string[],
    settings: PurchasingSettings,
  ) => {
    const authorized = hasPermission(context, 'inventory.read');
    const sources = authorized ? await authority.read(context) : null;
    const stockSource = sources?.groups.find(
      (g) => g.group === 'inventory_stock',
    );
    const sellingSource = sources?.groups.find(
      (g) => g.group === 'inventory_selling',
    );
    const stockConnection =
      stockSource?.state === 'resolved'
        ? stockSource.connectionId
        : sellingSource?.state === 'resolved'
          ? sellingSource.connectionId
          : null;
    const orderConnection =
      sources?.groups.find(
        (g) => g.group === 'order_lines' && g.state === 'resolved',
      )?.connectionId ?? null;

    return db.transaction(
      context.tenantId,
      async (tx) => {
        const rows =
          authorized && skuIds.length
            ? (
                await tx.query<{
                  id: string;
                  connection_id: string;
                  sku: string;
                  location: string;
                  document: StockDocument;
                  native_mode: string | null;
                }>(
                  `SELECT p.entity_id AS id,p.connection_id,s.document,e.reconciliation_key AS sku,CASE WHEN left(l.reconciliation_key,10)='["source",' THEN 'Location '||regexp_replace(l.reconciliation_key::jsonb->>4,'^.*/','') ELSE l.reconciliation_key END AS location,scope.mode AS native_mode
        FROM inventory_projections p JOIN inventory_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
        JOIN inventory_entities e ON e.tenant_id=p.tenant_id AND e.id=s.sku_id
        JOIN inventory_entities l ON l.tenant_id=p.tenant_id AND l.id=(s.document->'data'->>'locationId')::uuid
        LEFT JOIN inventory_stock_ownership_scopes scope ON scope.tenant_id=p.tenant_id AND scope.location_id=l.id
        WHERE p.tenant_id=$1 AND s.kind='position' AND s.sku_id=ANY($2::uuid[]) AND NOT (s.document->>'deleted')::boolean
        AND (cardinality($3::uuid[])=0 OR l.id=ANY($3::uuid[])) ORDER BY p.entity_id,p.connection_id LIMIT 1001`,
                  [context.tenantId, skuIds, settings.locationIds],
                )
              ).rows
            : [];
        const stocks: PurchasingStock[] = rows.slice(0, 1000).map((r) => ({
          positionId: r.id,
          skuId: r.document.data.skuId,
          sku: r.sku,
          locationId: r.document.data.locationId,
          location: r.location,
          connectionId: r.connection_id,
          unit: r.document.data.unit,
          available: number(r.document.data.available),
          reserved: number(r.document.data.reserved),
          observedAt: r.document.observedAt,
          observationId: r.document.observationId,
          complete:
            !r.document.deleted && number(r.document.data.available) !== null,
          authoritative:
            r.connection_id === stockConnection && r.native_mode !== 'own',
        }));
        const owned =
          authorized && skuIds.length
            ? (
                await tx.query<{
                  sku_id: string;
                  location_id: string;
                  unit: string;
                  balance: string;
                  connection_id: string;
                  updated_at: Date;
                  id: string;
                  location: string;
                  reserved: string;
                }>(
                  `SELECT a.sku_id,a.location_id,a.unit,a.balance::text,scope.connection_id,scope.updated_at,COALESCE(posting.entry_id,scope.last_transition_id) AS id,CASE WHEN left(l.reconciliation_key,10)='["source",' THEN 'Location '||regexp_replace(l.reconciliation_key::jsonb->>4,'^.*/','') ELSE l.reconciliation_key END AS location,
        COALESCE((SELECT sum(r.balance)::text FROM inventory_ledger_accounts r WHERE r.tenant_id=a.tenant_id AND r.sku_id=a.sku_id AND r.location_id=a.location_id AND r.unit=a.unit AND r.state='reserved'),'0') AS reserved
        FROM inventory_ledger_accounts a JOIN inventory_stock_ownership_scopes scope ON scope.tenant_id=a.tenant_id AND scope.location_id=a.location_id AND scope.mode='own'
        JOIN inventory_entities l ON l.tenant_id=a.tenant_id AND l.id=a.location_id
        LEFT JOIN inventory_ledger_postings posting ON posting.tenant_id=a.tenant_id AND posting.account_id=a.id AND posting.account_version=a.version
        WHERE a.tenant_id=$1 AND a.sku_id=ANY($2::uuid[]) AND a.state='available' AND (cardinality($3::uuid[])=0 OR a.location_id=ANY($3::uuid[])) LIMIT 1001`,
                  [context.tenantId, skuIds, settings.locationIds],
                )
              ).rows
            : [];
        for (const r of owned.slice(0, 1000)) {
          const positionId =
            stocks.find(
              (s) => s.skuId === r.sku_id && s.locationId === r.location_id,
            )?.positionId ?? r.id;
          for (let i = stocks.length - 1; i >= 0; i--)
            if (
              stocks[i]!.skuId === r.sku_id &&
              stocks[i]!.locationId === r.location_id
            )
              stocks.splice(i, 1);
          // Ledger balance is transactional local state; freshness is this read, not ownership activation time.
          stocks.push({
            positionId,
            skuId: r.sku_id,
            sku: r.sku_id,
            locationId: r.location_id,
            location: r.location,
            connectionId: r.connection_id,
            unit: r.unit,
            available: number(r.balance),
            reserved: number(r.reserved),
            observedAt: new Date().toISOString(),
            observationId: r.id,
            complete: true,
            authoritative: true,
          });
        }
        const demand = new Map<string, PurchasingDemand>();
        const since = new Date(
          Date.now() - settings.demandPeriodDays * 86_400_000,
        );
        const stream =
          hasPermission(context, 'orders.read') && orderConnection
            ? (
                await tx.query<{
                  last_complete_at: Date | null;
                  history_from: Date | null;
                  backfill_completed_at: Date | null;
                  recent_history_completed_at: Date | null;
                  recent_history_from: Date | null;
                  blocked: string | null;
                  paused: boolean;
                }>(
                  `SELECT last_complete_at,history_from,backfill_completed_at,recent_history_completed_at,recent_history_from,blocked,paused FROM commerce_sync_streams WHERE tenant_id=$1 AND connection_id=$2 AND record_type='orders'`,
                  [context.tenantId, orderConnection],
                )
              ).rows[0]
            : undefined;
        // A completed unbounded backfill covers the whole history; null is not missing evidence.
        const covered =
          !!stream &&
          ((!!stream.backfill_completed_at &&
            (stream.history_from === null || stream.history_from <= since)) ||
            (!!stream.recent_history_completed_at &&
              !!stream.recent_history_from &&
              stream.recent_history_from <= since));
        const complete =
          !!stream &&
          !stream.blocked &&
          !stream.paused &&
          covered &&
          !!stream.last_complete_at &&
          Date.now() - stream.last_complete_at.getTime() < 300_000;
        const orders = complete
          ? (
              await tx.query<{ document: OrderDocument }>(
                `SELECT s.document FROM orders_projections p JOIN orders_snapshots s ON s.tenant_id=p.tenant_id AND s.id=p.snapshot_id
         WHERE p.tenant_id=$1 AND p.connection_id=$2 AND s.kind='order' AND NOT (s.document->>'deleted')::boolean
         AND (s.document->'data'->>'placedAt')::timestamptz >= $3 AND (s.document->'data'->>'placedAt')::timestamptz <= now()
         AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.document->'data'->'lines') l WHERE l->>'skuId'=ANY($4::text[])) LIMIT 10001`,
                [context.tenantId, orderConnection, since, skuIds],
              )
            ).rows
          : [];
        for (const skuId of skuIds) {
          const relevant = orders.filter(
            (o) =>
              o.document.data.status !== 'cancelled' &&
              o.document.data.lines.some((l) => l.skuId === skuId),
          );
          const lines = relevant.flatMap((o) =>
            o.document.data.lines.filter((l) => l.skuId === skuId),
          );
          const usable =
            complete &&
            orders.length <= 10000 &&
            lines.every(
              (l) =>
                number(l.quantity) !== null && l.cancelledQuantity !== null,
            );
          const units = usable
            ? lines.reduce(
                (sum, l) =>
                  sum +
                  Math.max(
                    0,
                    number(l.quantity)! - number(l.cancelledQuantity)!,
                  ),
                0,
              )
            : null;
          demand.set(skuId, {
            daily: units === null ? null : units / settings.demandPeriodDays,
            units,
            periodDays: settings.demandPeriodDays,
            observedAt: stream?.last_complete_at?.toISOString() ?? null,
            evidenceRefs: relevant.map((o) => o.document.observationId),
            complete: usable,
          });
        }
        const rules = (
          await tx.query<{
            document: {
              positionId: string;
              sku: string;
              minimum: number;
              target: number;
              active: boolean;
            };
          }>(
            'SELECT document FROM replenishment_activations WHERE tenant_id=$1',
            [context.tenantId],
          )
        ).rows
          .map((r) => r.document)
          .filter((r) => r.active);

        return {
          stocks,
          demand,
          rules,
          truncated:
            rows.length > 1000 || owned.length > 1000 || orders.length > 10000,
        };
      },
      { readOnlySnapshot: true },
    );
  };
}
