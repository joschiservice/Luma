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
  fulfillmentSeries,
  fulfillmentWaits,
  insightSources,
} from '../../domain/insights.js';
import { classified, stalledAfterHours } from '../fulfillment/rules.js';
import { iso, text } from '../orders/values.js';
import { readConnectionLabels, readSourceReads } from './coverage.js';

const wait = `CASE ${fulfillmentWaits
  .filter((bucket) => bucket.before !== null)
  .map(
    (bucket) =>
      `WHEN c.progress_at>$2::timestamptz-make_interval(hours=>${bucket.before}) THEN '${bucket.key}'`,
  )
  .join(' ')} ELSE '${fulfillmentWaits.at(-1)!.key}' END`;

/*
 * Current open fulfillment work by time since its last reported progress, under its first
 * signal. These are the Fulfillment workspace's own rules and `open` view. Each source's
 * record counts, so work mirrored in two systems counts once per system.
 * Parameters: $1 tenant, $2 as-of time, $3 stall window, $4 connection.
 */
const rows = `${classified('f.open AND ($4::uuid IS NULL OR f.connection_id=$4)')}, rows AS (
 SELECT c.*,${wait} AS point,
  CASE WHEN c.held THEN 'held' WHEN c.overdue THEN 'overdue' WHEN c.stalled THEN 'stalled' ELSE 'none' END AS series
 FROM classified c
)`;

/** Counts open fulfillment work by waiting time and first signal, with source coverage. */
export async function fulfillmentChart(
  tx: SqlTransaction,
  tenantId: string,
  query: InsightQuery,
  asOf: string,
): Promise<InsightChartResponse> {
  const counts = await tx.query<{
    point: string;
    series: string;
    count: number;
  }>(
    `WITH ${rows} SELECT point,series,count(*)::int AS count FROM rows GROUP BY point,series`,
    [tenantId, asOf, stalledAfterHours, query.connectionId ?? null],
  );
  const sources = insightSources(
    await readSourceReads(tx, tenantId, {
      recordType: 'fulfillments',
      capability: 'fulfillment.read',
      table: 'orders_fulfillment_list',
      connectionId: query.connectionId,
    }),
    asOf,
    null,
  );
  const points = countPoints(
    fulfillmentWaits.map((bucket) => ({ key: bucket.key })),
    fulfillmentSeries,
    counts.rows,
  );

  return {
    chart: 'fulfillment',
    kind: 'breakdown',
    unit: 'fulfillment',
    series: fulfillmentSeries,
    points,
    total: points.reduce((sum, point) => sum + point.total, 0),
    window: null,
    sourceFilter: 'applied',
    coverage: { state: coverageState(sources), sources, excluded: [] },
    dataThrough: dataThrough(sources),
    asOf,
  };
}

/** Lists the open fulfillment work behind a point and series, longest waiting first. */
export async function fulfillmentRecords(
  tx: SqlTransaction,
  tenantId: string,
  query: InsightRecordQuery,
  asOf: string,
): Promise<{ totalCount: number; items: InsightRecord[] }> {
  const result = await tx.query<{
    total: number;
    items: Record<string, unknown>[] | null;
  }>(
    `WITH ${rows}, matched AS (
      SELECT * FROM rows WHERE ($5::text IS NULL OR point=$5) AND ($6::text IS NULL OR series=$6)
     ), page AS (
      SELECT * FROM matched ORDER BY progress_at,entity_id,connection_id LIMIT $7 OFFSET $8
     )
     SELECT (SELECT count(*)::int FROM matched) AS total,
      (SELECT jsonb_agg(jsonb_build_object('id',p.entity_id,'connectionId',p.connection_id,'kind',p.kind,
        'status',p.status,'signals',to_jsonb(array_remove(ARRAY[CASE WHEN p.held THEN 'held' END,
         CASE WHEN p.overdue THEN 'overdue' END,CASE WHEN p.stalled THEN 'stalled' END],NULL)),
        'progressAt',p.progress_at,'lastProgressAt',p.last_progress_at,'fulfillBy',p.fulfill_by,
        'locationName',p.location_name,'units',trim_scale(p.units)::text,'unit',p.unit,
        'orderId',p.order_id,'orderNumber',p.order_number)
       ORDER BY p.progress_at,p.entity_id,p.connection_id) FROM page p) AS items`,
    [
      tenantId,
      asOf,
      stalledAfterHours,
      query.connectionId ?? null,
      query.point ?? null,
      query.series ?? null,
      query.limit,
      query.offset,
    ],
  );
  const row = result.rows[0]!;
  const items = row.items ?? [];
  const labels = await readConnectionLabels(
    tx,
    tenantId,
    items.map((item) => String(item.connectionId)),
  );

  return {
    totalCount: row.total,
    items: items.map((item) => ({
      kind: 'fulfillment',
      id: String(item.id),
      source: {
        connectionId: String(item.connectionId),
        label: labels.get(String(item.connectionId)) ?? 'Connected source',
      },
      workKind: text(item.kind),
      status: text(item.status) ?? 'unknown',
      signals: Array.isArray(item.signals) ? item.signals.map(String) : [],
      progressAt: iso(item.progressAt)!,
      lastProgressAt: iso(item.lastProgressAt),
      fulfillBy: iso(item.fulfillBy),
      locationName: text(item.locationName),
      units: text(item.units) ?? '0',
      unit: text(item.unit),
      order: { id: String(item.orderId), number: text(item.orderNumber) },
    })),
  };
}
