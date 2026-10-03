import type { SqlTransaction } from '@luma/platform';

import type {
  InsightChartResponse,
  InsightQuery,
  InsightRecord,
  InsightRecordQuery,
} from '../../application/insights.js';
import { caseSeries, countPoints } from '../../domain/insights.js';
import { iso, text } from '../orders/values.js';
import { bucketRelation, readWindow } from './window.js';

/*
 * Issues by the day or week Luma first detected them, by class. A reopened issue keeps its
 * first detection. `timeline` is the exceptions owner's query; it binds $1 tenant and $2 as-of
 * time. $3–$5 are the buckets.
 */
const rows = (
  timeline: string,
) => `timeline AS (${timeline}), ${bucketRelation(3, 4, 5)}, rows AS (
 SELECT t.*,b.key AS point,t.class AS series
 FROM timeline t JOIN buckets b ON t.detected_at>=b.from_at AND t.detected_at<b.before_at
 WHERE t.class=ANY('{${caseSeries.join(',')}}'::text[])
)`;

async function prepare(
  tx: SqlTransaction,
  tenantId: string,
  query: InsightQuery,
  asOf: string,
) {
  const { window, buckets } = await readWindow(
    tx,
    query.range,
    query.timeZone,
    asOf,
  );

  return {
    window,
    buckets,
    values: [
      tenantId,
      asOf,
      buckets.map((b) => b.key),
      buckets.map((b) => b.from),
      buckets.map((b) => b.before),
    ] as unknown[],
  };
}

/** Counts issues by first detection and class. Luma's own records are complete in scope. */
export async function caseChart(
  tx: SqlTransaction,
  timeline: string,
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
    `WITH ${rows(timeline)} SELECT point,series,count(*)::int AS count FROM rows GROUP BY point,series`,
    values,
  );
  const excluded = await tx.query<{ undated: number; other: number }>(
    `WITH timeline AS (${timeline})
     SELECT count(*) FILTER (WHERE detected_at IS NULL)::int AS undated,
      count(*) FILTER (WHERE detected_at>=$3 AND detected_at<$4
       AND class<>ALL('{${caseSeries.join(',')}}'::text[]))::int AS other FROM timeline`,
    [tenantId, asOf, window.from, window.before],
  );
  const { undated, other } = excluded.rows[0]!;
  const points = countPoints(buckets, caseSeries, counts.rows);

  return {
    chart: 'cases',
    kind: 'timeline',
    unit: 'case',
    series: caseSeries,
    points,
    total: points.reduce((sum, point) => sum + point.total, 0),
    window,
    sourceFilter: 'not_applicable',
    coverage: {
      state: 'complete',
      sources: [],
      excluded: [
        ...(undated ? [{ reason: 'no_detection_time', count: undated }] : []),
        ...(other ? [{ reason: 'other_class', count: other }] : []),
      ],
    },
    dataThrough: asOf,
    asOf,
  };
}

/** Lists the issues behind a point and series, newest detection first. */
export async function caseRecords(
  tx: SqlTransaction,
  timeline: string,
  tenantId: string,
  query: InsightRecordQuery,
  asOf: string,
): Promise<{ totalCount: number; items: InsightRecord[] }> {
  const { values } = await prepare(tx, tenantId, query, asOf);
  const result = await tx.query<{
    total: number;
    items: Record<string, unknown>[] | null;
  }>(
    `WITH ${rows(timeline)}, matched AS (
      SELECT * FROM rows WHERE ($6::text IS NULL OR point=$6) AND ($7::text IS NULL OR series=$7)
     ), page AS (SELECT * FROM matched ORDER BY detected_at DESC,id LIMIT $8 OFFSET $9)
     SELECT (SELECT count(*)::int FROM matched) AS total,
      (SELECT jsonb_agg(jsonb_build_object('id',id,'class',class,'severity',severity,'state',state,
        'detectedAt',detected_at,'resolvedAt',resolved_at,'resolution',resolution,'attention',attention)
       ORDER BY detected_at DESC,id) FROM page) AS items`,
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
    items: (row.items ?? []).map((item) => {
      const resolution = text(item.resolution);

      return {
        kind: 'case',
        id: String(item.id),
        class: text(item.class) ?? 'unknown',
        severity: text(item.severity),
        state: text(item.state) ?? 'unknown',
        detectedAt: iso(item.detectedAt)!,
        resolvedAt: iso(item.resolvedAt),
        resolution:
          resolution === 'verified' || resolution === 'human_disposition'
            ? resolution
            : null,
        attention: text(item.attention),
      };
    }),
  };
}
