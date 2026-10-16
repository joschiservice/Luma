import type { SqlTransaction } from '@luma/platform';

import type {
  InsightRange,
  InsightWindow,
} from '../../application/insights.js';
import { iso } from '../orders/values.js';

export interface Bucket {
  key: string;
  start: string;
  end: string;
  from: string;
  before: string;
}

/**
 * Computes the calendar buckets of a range ending on `asOf`'s day in `timeZone`. Days and
 * weeks (starting Monday) begin at local midnight; the last bucket ends at the start of the
 * next local day, so the current day or week is partial.
 */
async function readWindow(
  tx: SqlTransaction,
  range: InsightRange,
  timeZone: string,
  asOf: string,
): Promise<{ window: InsightWindow; buckets: Bucket[] }> {
  const result = await tx.query<{
    start: string;
    end: string;
    from: Date;
    before: Date;
  }>(
    `WITH t AS (SELECT ($1::timestamptz AT TIME ZONE $2)::date AS today),
     s AS (SELECT today,CASE $3 WHEN '7d' THEN today-6 WHEN '30d' THEN today-29
       ELSE date_trunc('week',today)::date-84 END AS first,
       CASE $3 WHEN '13w' THEN 7 ELSE 1 END AS step FROM t)
     SELECT to_char(d,'YYYY-MM-DD') AS start,to_char(LEAST(d+s.step-1,s.today),'YYYY-MM-DD') AS "end",
      (d::timestamp AT TIME ZONE $2) AS "from",(LEAST(d+s.step,s.today+1)::timestamp AT TIME ZONE $2) AS before
     FROM s CROSS JOIN LATERAL (SELECT s.first+n*s.step AS d
      FROM generate_series(0,(s.today-s.first)/s.step) n) g ORDER BY d`,
    [asOf, timeZone, range],
  );
  const buckets = result.rows.map((row) => ({
    key: row.start,
    start: row.start,
    end: row.end,
    from: iso(row.from)!,
    before: iso(row.before)!,
  }));

  return {
    window: {
      range,
      bucket: range === '13w' ? 'week' : 'day',
      start: buckets[0]!.start,
      end: buckets.at(-1)!.end,
      from: buckets[0]!.from,
      before: buckets.at(-1)!.before,
      timeZone,
    },
    buckets,
  };
}

/**
 * SQL for a `buckets(key,from_at,before_at)` relation over the parameters holding the bucket
 * keys, starts and ends.
 */
export const bucketRelation = (keys: number, froms: number, befores: number) =>
  `buckets AS (SELECT * FROM unnest($${keys}::text[],$${froms}::timestamptz[],$${befores}::timestamptz[]) AS b(key,from_at,before_at))`;

/** The point key that selects a timeline's previous stretch in record queries. */
const previousPoint = 'previous';

const rangeDays = { '7d': 7, '30d': 30, '13w': 91 } as const;

/**
 * The stretch of the preceding period that matches the elapsed part of `window`: it starts one
 * range length before the window, at local midnight, and ends one range length before `asOf`
 * in local time, so daylight saving changes don't shift it. `start` and `end` are its first
 * and last local days.
 */
export async function readPreviousWindow(
  tx: SqlTransaction,
  window: InsightWindow,
  asOf: string,
): Promise<Bucket> {
  const result = await tx.query<{
    start: string;
    end: string;
    from: Date;
    before: Date;
  }>(
    `WITH p AS (SELECT $1::date-$3::int AS first,
       ($4::timestamptz AT TIME ZONE $2)-make_interval(days=>$3::int) AS until)
     SELECT to_char(first,'YYYY-MM-DD') AS start,to_char(until::date,'YYYY-MM-DD') AS "end",
      (first::timestamp AT TIME ZONE $2) AS "from",(until AT TIME ZONE $2) AS before FROM p`,
    [window.start, window.timeZone, rangeDays[window.range], asOf],
  );
  const row = result.rows[0]!;

  return {
    key: previousPoint,
    start: row.start,
    end: row.end,
    from: iso(row.from)!,
    before: iso(row.before)!,
  };
}

/**
 * The window and buckets a record query matches. For `previousPoint`, the previous stretch is
 * the window and its only bucket, so its records total the chart's `previous` count.
 */
export async function readRecordWindow(
  tx: SqlTransaction,
  query: { range: InsightRange; timeZone: string; point?: string | undefined },
  asOf: string,
): Promise<{ window: InsightWindow; buckets: Bucket[] }> {
  const read = await readWindow(tx, query.range, query.timeZone, asOf);
  if (query.point !== previousPoint) return read;
  const span = await readPreviousWindow(tx, read.window, asOf);

  return {
    window: {
      ...read.window,
      start: span.start,
      end: span.end,
      from: span.from,
      before: span.before,
    },
    buckets: [span],
  };
}
