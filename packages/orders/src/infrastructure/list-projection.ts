import type { TenantContext } from '@luma/identity';
import { requirePermission } from '@luma/identity';
import type { SqlTransaction, TenantDatabase } from '@luma/platform';

import { readOrderComparisons } from './comparison-projection.js';
import { refreshFulfillmentList } from './fulfillment-list.js';
import {
  currentOrderSources,
  orderProgress,
  sourceSelectionOrder,
} from './order-state.js';

const timestampKey = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')`;

// The snapshot's total as `amount` and `currency`, both null unless the amount is a plain
// decimal and the currency an ISO code, so a malformed source total never fails a refresh.
const orderTotal = (
  snapshot: string,
) => `SELECT CASE WHEN ok THEN (t->>'amount')::numeric END AS amount,CASE WHEN ok THEN t->>'currency' END AS currency
 FROM (SELECT t,(t->>'amount' ~ '^-?[0-9]{1,30}(\\.[0-9]{1,30})?$' AND t->>'currency' ~ '^[A-Z]{3}$') AS ok
  FROM (SELECT document->'data'->'total' AS t FROM orders_snapshots WHERE tenant_id=$1 AND id=${snapshot}) s) v`;

/**
 * Rebuilds locked orders from their current source pointers in the caller's transaction.
 * Callers must hold the orders:<tenant>:<order> lock for each ID, in sorted order.
 */
export async function refreshOrderList(
  tx: SqlTransaction,
  tenant: string,
  ids: string[],
  refreshSearch = true,
) {
  if (!ids.length) return;
  await tx.query('SET LOCAL jit = off');
  await tx.query(
    `DELETE FROM orders_list o WHERE o.tenant_id=$1 AND o.entity_id=ANY($2::uuid[])
    AND NOT EXISTS (SELECT 1 FROM orders_projections p WHERE p.tenant_id=$1
      AND p.entity_id=o.entity_id AND p.connection_id=o.connection_id)`,
    [tenant, ids],
  );
  // Clear selection first because a different source may now win the unique partial index.
  await tx.query(
    'UPDATE orders_list SET selected=false WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[]) AND selected',
    [tenant, ids],
  );
  const comparisons = await readOrderComparisons(tx, tenant, ids);
  await tx.query(
    `WITH comparisons AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS v(entity_id uuid,connection_id uuid,signature text,changed_at timestamptz,raw text,read_at timestamptz,latest_read_at timestamptz,confirm_after timestamptz,differences jsonb)), ${currentOrderSources('sources', 'p.entity_id=ANY($3::uuid[])')},
    ${orderProgress('sources')},
    winners AS (SELECT DISTINCT ON(entity_id) entity_id,connection_id FROM sources WHERE NOT shipping_view ORDER BY entity_id,${sourceSelectionOrder})
    INSERT INTO orders_list(tenant_id,entity_id,connection_id,snapshot_id,selected,status,payment_status,display_number,
      observed_at,source_updated_at,placed_at,due_at,deleted,line_count,fulfillment,open,state_valid_from,differs,
      updated_key,placed_key,placed_rank,number_key,number_rank,due_key,due_rank,external_order_number,comparison_signature,comparison_changed_at,comparison_raw,comparison_read_at,comparison_latest_read_at,comparison_confirm_after,comparison_differences,total_amount,total_currency,
      channel,currency,test,cancel_reason)
    SELECT $1,o.entity_id,o.connection_id,o.snapshot_id,COALESCE(w.connection_id=o.connection_id,false),o.status,o.payment_status,o.display_number,
      o.observed_at,o.source_updated_at,o.placed_at,o.due_at,o.deleted,o.line_count,o.fulfillment,o.open,
      GREATEST(o.observed_at,COALESCE((SELECT max(s.observed_at) FROM orders_snapshots s
       JOIN orders_projections p ON p.tenant_id=s.tenant_id AND p.entity_id=s.entity_id AND p.snapshot_id=s.id AND p.connection_id=s.connection_id
       WHERE s.tenant_id=$1 AND s.order_id=o.entity_id AND s.connection_id=o.connection_id
       AND s.kind='fulfillment' AND s.status IN ('completed','shipped','delivered') AND NOT (s.document->>'deleted')::boolean),o.observed_at)),
      v.raw='different',
      ${timestampKey('COALESCE(o.source_updated_at,o.observed_at)')},
      COALESCE(${timestampKey('o.placed_at')},''),(o.placed_at IS NULL)::int,
      COALESCE(lpad(length(o.display_number)::text,6,'0')||left(lower(o.display_number),120),''),(o.display_number IS NULL)::int,
      COALESCE(${timestampKey('o.due_at')},''),(o.due_at IS NULL)::int,
      (SELECT obs.document->'observation'->'data'->>'externalOrderNumber' FROM orders_snapshots snap
       JOIN connector_observations obs ON obs.tenant_id=snap.tenant_id AND obs.id=snap.observation_id
       WHERE snap.tenant_id=$1 AND snap.id=o.snapshot_id),
      v.signature,v.changed_at,COALESCE(v.raw,'inconclusive'),v.read_at,v.latest_read_at,v.confirm_after,COALESCE(v.differences,'[]'::jsonb),
      total.amount,total.currency,facts.channel,facts.currency,facts.test,facts.cancel_reason
    FROM order_state o LEFT JOIN winners w USING(entity_id) LEFT JOIN comparisons v ON v.entity_id=o.entity_id AND v.connection_id=o.connection_id
    LEFT JOIN LATERAL (${orderTotal('o.snapshot_id')}) total ON true
    LEFT JOIN LATERAL (SELECT f.* FROM orders_snapshots snap CROSS JOIN LATERAL orders_commercial_scalars(snap.document->'data') f
      WHERE snap.tenant_id=$1 AND snap.id=o.snapshot_id) facts ON true
    ON CONFLICT(tenant_id,entity_id,connection_id) DO UPDATE SET
      snapshot_id=EXCLUDED.snapshot_id,selected=EXCLUDED.selected,status=EXCLUDED.status,payment_status=EXCLUDED.payment_status,
      display_number=EXCLUDED.display_number,observed_at=EXCLUDED.observed_at,source_updated_at=EXCLUDED.source_updated_at,
      placed_at=EXCLUDED.placed_at,due_at=EXCLUDED.due_at,deleted=EXCLUDED.deleted,line_count=EXCLUDED.line_count,
      fulfillment=EXCLUDED.fulfillment,open=EXCLUDED.open,state_valid_from=EXCLUDED.state_valid_from,differs=EXCLUDED.differs,
      updated_key=EXCLUDED.updated_key,placed_key=EXCLUDED.placed_key,placed_rank=EXCLUDED.placed_rank,
      number_key=EXCLUDED.number_key,number_rank=EXCLUDED.number_rank,due_key=EXCLUDED.due_key,due_rank=EXCLUDED.due_rank,external_order_number=EXCLUDED.external_order_number,
      comparison_signature=EXCLUDED.comparison_signature,comparison_changed_at=EXCLUDED.comparison_changed_at,
      comparison_raw=EXCLUDED.comparison_raw,comparison_read_at=EXCLUDED.comparison_read_at,
      comparison_latest_read_at=EXCLUDED.comparison_latest_read_at,comparison_confirm_after=EXCLUDED.comparison_confirm_after,
      comparison_differences=EXCLUDED.comparison_differences,total_amount=EXCLUDED.total_amount,total_currency=EXCLUDED.total_currency,
      channel=EXCLUDED.channel,currency=EXCLUDED.currency,test=EXCLUDED.test,cancel_reason=EXCLUDED.cancel_reason`,
    [tenant, 'infinity', ids, JSON.stringify(comparisons)],
  );
  // Tags, discount codes and shipping methods follow each list row's current snapshot.
  await tx.query(
    'DELETE FROM orders_list_facets WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[])',
    [tenant, ids],
  );
  await tx.query(
    `INSERT INTO orders_list_facets(tenant_id,kind,value,entity_id,connection_id)
    SELECT DISTINCT o.tenant_id,f.kind,f.value,o.entity_id,o.connection_id
    FROM orders_list o JOIN orders_snapshots s ON s.tenant_id=o.tenant_id AND s.id=o.snapshot_id
    CROSS JOIN LATERAL orders_commercial_facets(s.document->'data') f
    WHERE o.tenant_id=$1 AND o.entity_id=ANY($2::uuid[]) AND NOT o.deleted`,
    [tenant, ids],
  );
  if (!refreshSearch) return;
  await tx.query(
    'DELETE FROM orders_search_links WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[])',
    [tenant, ids],
  );
  const searchValues = `SELECT DISTINCT o.tenant_id,o.entity_id,o.connection_id,v.value
    FROM orders_list o JOIN orders_snapshots s ON s.tenant_id=o.tenant_id AND s.id=o.snapshot_id
    CROSS JOIN LATERAL (SELECT o.display_number AS value UNION SELECT l->>'skuCode'
      FROM jsonb_array_elements(s.document->'data'->'lines') l) v
    WHERE o.tenant_id=$1 AND o.entity_id=ANY($2::uuid[]) AND NOT o.deleted AND v.value IS NOT NULL AND v.value<>''`;
  // Shared SKU text is indexed once per tenant, rather than once per order. Sort dictionary
  // inserts consistently so concurrent orders sharing several values cannot deadlock.
  await tx.query(
    `WITH inserted AS (
    INSERT INTO orders_search_values(tenant_id,value,value_hash)
    SELECT DISTINCT tenant_id,value,sha256(convert_to(value,'UTF8')) FROM (${searchValues}) v
    ORDER BY sha256(convert_to(value,'UTF8'))
    ON CONFLICT(tenant_id,value_hash) DO NOTHING RETURNING tenant_id,id,value)
    INSERT INTO orders_search_grams(tenant_id,gram,value_id)
    SELECT tenant_id,unnest(luma_search_grams(value)),id FROM inserted`,
    [tenant, ids],
  );
  // Compute hashes after source RLS checks; dictionary lookups then compare plain columns.
  await tx.query(
    `WITH search_values AS MATERIALIZED (
      SELECT v.*,sha256(convert_to(value,'UTF8')) AS value_hash FROM (${searchValues}) v
    ) INSERT INTO orders_search_links(tenant_id,entity_id,connection_id,value_id)
    SELECT v.tenant_id,v.entity_id,v.connection_id,d.id FROM search_values v
    CROSS JOIN LATERAL (SELECT id FROM orders_search_values d WHERE d.tenant_id=$1
      AND d.value_hash=v.value_hash AND d.value=v.value OFFSET 0) d`,
    [tenant, ids],
  );
  await tx.query(
    'DELETE FROM orders_list_skus WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[])',
    [tenant, ids],
  );
  await tx.query(
    `INSERT INTO orders_list_skus(tenant_id,sku_id,entity_id,connection_id)
    SELECT DISTINCT o.tenant_id,(l->>'skuId')::uuid,o.entity_id,o.connection_id
    FROM orders_list o JOIN orders_snapshots s ON s.tenant_id=o.tenant_id AND s.id=o.snapshot_id
    CROSS JOIN LATERAL jsonb_array_elements(s.document->'data'->'lines') l
    WHERE o.tenant_id=$1 AND o.entity_id=ANY($2::uuid[]) AND NOT o.deleted AND l->>'skuId' IS NOT NULL`,
    [tenant, ids],
  );
}

/**
 * Rebuilds a bounded tenant batch, including existing rows for repair. Persist the returned
 * cursor to resume; null means complete. Concurrent ingestion shares the per-order locks.
 */
export function createOrderListRebuilder(db: TenantDatabase) {
  return async (
    context: TenantContext,
    after?: string,
    limit = 500,
  ): Promise<string | null> => {
    requirePermission(context, 'sync.manage');
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000)
      throw new Error('Batch size must be between 1 and 2000');

    return db.transaction(context.tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `orders-backfill:${context.tenantId}`,
      ]);
      const pending = (
        await tx.query<{ after_id: string | null }>(
          'SELECT after_id FROM orders_list_backfill WHERE tenant_id=$1',
          [context.tenantId],
        )
      ).rows[0];
      if (pending && after !== undefined && after !== pending.after_id)
        throw new Error('Backfill cursor does not match the saved checkpoint');
      const cursor = after ?? pending?.after_id ?? null;
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM orders_entities
        WHERE tenant_id=$1 AND kind='order' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,
        [context.tenantId, cursor, limit],
      );
      await tx.query(
        `WITH ids AS MATERIALIZED (SELECT id FROM unnest($2::uuid[]) id ORDER BY id)
        SELECT pg_advisory_xact_lock(hashtextextended('orders:' || $1 || ':' || id::text,0)) FROM ids`,
        [context.tenantId, rows.map(({ id }) => id)],
      );
      await refreshOrderList(
        tx,
        context.tenantId,
        rows.map(({ id }) => id),
      );
      await refreshFulfillmentList(
        tx,
        context.tenantId,
        rows.map(({ id }) => id),
      );
      const next = rows.length === limit ? rows.at(-1)!.id : null;
      if (next)
        await tx.query(
          'UPDATE orders_list_backfill SET after_id=$2 WHERE tenant_id=$1',
          [context.tenantId, next],
        );
      else
        await tx.query('DELETE FROM orders_list_backfill WHERE tenant_id=$1', [
          context.tenantId,
        ]);

      return next;
    });
  };
}
