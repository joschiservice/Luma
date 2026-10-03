import { IdentityError } from '@luma/identity';
import type { SqlTransaction } from '@luma/platform';

import type {
  InsightChartResponse,
  InsightQuery,
  InsightRecord,
  InsightRecordQuery,
} from '../../application/insights.js';
import {
  countPoints,
  coverageState,
  dataThrough,
  insightSources,
  orderSeries,
  pointCoverage,
} from '../../domain/insights.js';
import type { OrderReadQueries } from '../orders/list-query.js';
import { iso, money, text } from '../orders/values.js';
import { readSourceReads } from './coverage.js';
import { bucketRelation, readWindow } from './window.js';

const unavailable = () =>
  new IdentityError(
    503,
    'SERVICE_UNAVAILABLE',
    'Order history is being prepared for charts. Try again in a few minutes.',
  );

/*
 * Orders placed in each bucket, by current status. Without a connection, each canonical order
 * counts once through its selected source row, so orders linked across sources are not added
 * twice; with one, that source's own row counts. This is the Orders list's `placed` filter.
 * Parameters: $1 tenant, $2 as-of time, $3 connection, $4–$6 buckets, $7–$8 window.
 */
const rows = `${bucketRelation(4, 5, 6)}, rows AS (
 SELECT o.entity_id AS id,b.key AS point,
  CASE WHEN o.status IN ('open','completed','cancelled') THEN o.status ELSE 'unknown' END AS series,
  o.placed_at,o.connection_id,o.snapshot_id,o.display_number,o.status,o.fulfillment
 FROM orders_list o JOIN buckets b ON o.placed_at>=b.from_at AND o.placed_at<b.before_at
 WHERE o.tenant_id=$1 AND (CASE WHEN $3::uuid IS NULL THEN o.selected ELSE o.connection_id=$3 END)
  AND o.placed_at>=$7 AND o.placed_at<$8 AND $2::timestamptz IS NOT NULL
)`;

async function ready(tx: SqlTransaction, tenantId: string) {
  const backfill = await tx.query(
    'SELECT 1 FROM orders_list_backfill WHERE tenant_id=$1',
    [tenantId],
  );
  if (backfill.rowCount) throw unavailable();
}

async function prepare(
  tx: SqlTransaction,
  tenantId: string,
  query: InsightQuery,
  asOf: string,
) {
  await ready(tx, tenantId);
  const { window, buckets } = await readWindow(
    tx,
    query.range,
    query.timeZone,
    asOf,
  );
  const values: unknown[] = [
    tenantId,
    asOf,
    query.connectionId ?? null,
    buckets.map((b) => b.key),
    buckets.map((b) => b.from),
    buckets.map((b) => b.before),
    window.from,
    window.before,
  ];

  return { window, buckets, values };
}

/** Counts orders placed per calendar bucket, by current status, with source coverage. */
export async function orderChart(
  tx: SqlTransaction,
  tenantId: string,
  query: InsightQuery,
  asOf: string,
): Promise<InsightChartResponse> {
  const { window, buckets, values } = await prepare(tx, tenantId, query, asOf);
  const counts = await tx.query<{
    point: string;
    series: string;
    count: number;
  }>(
    `WITH ${rows} SELECT point,series,count(*)::int AS count FROM rows GROUP BY point,series`,
    values,
  );
  const undated = await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM orders_list o WHERE o.tenant_id=$1 AND o.placed_at IS NULL
     AND (CASE WHEN $2::uuid IS NULL THEN o.selected ELSE o.connection_id=$2 END)`,
    [tenantId, query.connectionId ?? null],
  );
  const sources = insightSources(
    await readSourceReads(tx, tenantId, {
      recordType: 'orders',
      capability: 'orders.read',
      table: 'orders_list',
      connectionId: query.connectionId,
    }),
    asOf,
    window.from,
  );
  const through = dataThrough(sources);
  const points = countPoints(
    buckets.map((bucket) => ({
      ...bucket,
      coverage: pointCoverage(bucket, sources, through),
    })),
    orderSeries,
    counts.rows,
  );
  const excluded = undated.rows[0]!.count;

  return {
    chart: 'orders',
    kind: 'timeline',
    unit: 'order',
    series: orderSeries,
    points,
    total: points.reduce((sum, point) => sum + point.total, 0),
    window,
    sourceFilter: 'applied',
    coverage: {
      state: coverageState(sources),
      sources,
      excluded: excluded ? [{ reason: 'no_placed_time', count: excluded }] : [],
    },
    dataThrough: through,
    asOf,
  };
}

/** Lists the orders behind a point and series, newest placed first. */
export async function orderRecords(
  tx: SqlTransaction,
  queries: OrderReadQueries,
  tenantId: string,
  query: InsightRecordQuery,
  asOf: string,
): Promise<{ totalCount: number; items: InsightRecord[] }> {
  const { values } = await prepare(tx, tenantId, query, asOf);
  const result = await tx.query<{
    total: number;
    items: Record<string, unknown>[] | null;
  }>(
    `WITH ${rows}, matched AS (
      SELECT * FROM rows WHERE ($9::text IS NULL OR point=$9) AND ($10::text IS NULL OR series=$10)
     ), page AS (
      SELECT id AS entity_id,* FROM matched ORDER BY placed_at DESC,id LIMIT $11 OFFSET $12
     ), attention AS (
      SELECT order_id,array_agg(DISTINCT issue_id ORDER BY issue_id) AS issue_ids
      FROM (${queries.attentionFor?.('page') ?? queries.attention}) a GROUP BY order_id
     )
     SELECT (SELECT count(*)::int FROM matched) AS total,
      (SELECT jsonb_agg(jsonb_build_object('id',p.id,'number',p.display_number,'placedAt',p.placed_at,
        'status',p.status,'fulfillment',p.fulfillment,
        'total',(SELECT document->'data'->'total' FROM orders_snapshots WHERE tenant_id=$1 AND id=p.snapshot_id),
        'sources',(SELECT jsonb_agg(jsonb_build_object('connectionId',c.id,
           'label',COALESCE(c.document->>'label',c.document->'target'->>'kind','Connected source')) ORDER BY c.id)
          FROM connector_installations c WHERE c.tenant_id=$1 AND c.id IN (
           SELECT connection_id FROM orders_projections WHERE tenant_id=$1 AND entity_id=p.id)),
        'issueIds',COALESCE(a.issue_ids,'{}'::uuid[])) ORDER BY p.placed_at DESC,p.id)
       FROM page p LEFT JOIN attention a ON a.order_id=p.id) AS items`,
    [
      ...values,
      query.point ?? null,
      query.series ?? null,
      query.limit,
      query.offset,
    ],
  );
  const row = result.rows[0]!;

  return {
    totalCount: row.total,
    items: (row.items ?? []).map((item) => ({
      kind: 'order',
      id: String(item.id),
      number: text(item.number),
      placedAt: iso(item.placedAt),
      status: text(item.status) ?? 'unknown',
      fulfillment: text(item.fulfillment) ?? 'unknown',
      total: money(item.total),
      sources: Array.isArray(item.sources)
        ? (item.sources as Record<string, unknown>[]).map((source) => ({
            connectionId: String(source.connectionId),
            label: text(source.label) ?? 'Connected source',
          }))
        : [],
      attentionIssueIds: Array.isArray(item.issueIds)
        ? item.issueIds.map(String)
        : [],
    })),
  };
}
