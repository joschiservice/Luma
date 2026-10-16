import { z } from 'zod';

import { caseStates } from './cases.js';

const timestamp = z.string().datetime({ offset: true });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Whether the runtime can convert instants to wall-clock time in `value`. */
function knownTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });

    return true;
  } catch {
    return false;
  }
}

/**
 * Operational charts. `orders` counts canonical orders by source placed time and current status;
 * `fulfillment` counts current open fulfillment work by waiting time; `stock` classifies
 * monitored stock positions; `cases` counts issues by first detection; `procurement` counts
 * purchase orders by current stage. Resolution performance is reported separately.
 */
export const insightChartSchema = z.enum([
  'orders',
  'fulfillment',
  'stock',
  'cases',
  'procurement',
]);

/** Time windows ending today in the requested time zone: 7 or 30 days by day, 13 weeks by week. */
const insightRangeSchema = z.enum(['7d', '30d', '13w']);

const insightUnitSchema = z.enum([
  'order',
  'fulfillment',
  'stock_position',
  'case',
  'purchase_order',
]);

const queryShape = {
  range: insightRangeSchema.default('30d'),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(knownTimeZone, 'Use an IANA time zone, such as Europe/Berlin')
    .default('UTC')
    .describe('Calendar days and weeks are counted in this time zone.'),
  connectionId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Count only records reported by this connection. Charts of Luma records ignore it.',
    ),
};

export const insightQuerySchema = z.object(queryShape).strict();

export const insightRecordQuerySchema = z
  .object({
    ...queryShape,
    point: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        'A point key from the chart, or `previous` for a timeline’s previous stretch. Omit to list every point.',
      ),
    series: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('A series ID from the chart. Omit to list every series.'),
    asOf: timestamp
      .optional()
      .describe(
        'The chart’s evaluation time, at most 15 minutes old, so time-based rules classify records the same way. Defaults to now.',
      ),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

/**
 * How imported history covers a point: `not_imported` lies wholly before every source's
 * imported history, so missing records are unknown rather than zero; `partial` starts before
 * some source's history or extends past `dataThrough`. Sources that were never imported are
 * reported by the chart's `coverage` instead.
 */
const insightPointCoverageSchema = z.enum([
  'complete',
  'partial',
  'not_imported',
]);

const insightPointSchema = z.object({
  key: z.string(),
  /** First and last calendar day of a timeline bucket, in the requested time zone. */
  start: day.nullable(),
  end: day.nullable(),
  /** The bucket's half-open instant range `[from, before)`. */
  from: timestamp.nullable(),
  before: timestamp.nullable(),
  /** Records per series ID. Every series is present, with zero when nothing matches. */
  values: z.record(z.string(), z.number().int().nonnegative()),
  total: z.number().int().nonnegative(),
  coverage: insightPointCoverageSchema,
});

/**
 * What one connection contributes: `complete` imported history covering the window and recently
 * read through `dataThrough`; `limited` history starting after the window starts; `importing`
 * history still loading; `stale` no complete read for 24 hours; `failing` the last read failed;
 * `paused` sync is paused or blocked; `disconnected` the connection no longer reads;
 * `not_synced` records arrive only as individual observations, with no complete import.
 */
const insightSourceStateSchema = z.enum([
  'complete',
  'limited',
  'importing',
  'stale',
  'failing',
  'paused',
  'disconnected',
  'not_synced',
]);

const insightSourceSchema = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
  system: z.string().nullable(),
  state: insightSourceStateSchema,
  /** Records created before this time were not imported. */
  historyFrom: timestamp.nullable(),
  /** Start of the last complete read; later source changes may not be counted yet. */
  dataThrough: timestamp.nullable(),
  lastReadAt: timestamp.nullable(),
});

const insightCoverageSchema = z.object({
  /**
   * `complete` every source covers the window; `partial` at least one source is limited,
   * importing, failing, paused or not synced; `stale` reads are older than 24 hours;
   * `unavailable` nothing in scope can report these records, so no count means zero.
   */
  state: z.enum(['complete', 'partial', 'stale', 'unavailable']),
  sources: z.array(insightSourceSchema),
  /** Records in scope that the chart cannot place, such as orders without a placed time. */
  excluded: z.array(
    z.object({ reason: z.string(), count: z.number().int().positive() }),
  ),
});

export const insightChartResponseSchema = z.object({
  chart: insightChartSchema,
  /** `timeline` points are calendar buckets; `breakdown` points are current-state categories. */
  kind: z.enum(['timeline', 'breakdown']),
  unit: insightUnitSchema,
  /** Series IDs in stacking order. */
  series: z.array(z.string()),
  points: z.array(insightPointSchema),
  total: z.number().int().nonnegative(),
  window: z
    .object({
      range: insightRangeSchema,
      bucket: z.enum(['day', 'week']),
      start: day,
      end: day,
      from: timestamp,
      before: timestamp,
      timeZone: z.string(),
    })
    .nullable(),
  /** Whether `connectionId` narrowed the records; Luma-owned records ignore it. */
  sourceFilter: z.enum(['applied', 'not_applicable']),
  coverage: insightCoverageSchema,
  /** Every counted record reflects source changes up to this time; null when unknown. */
  dataThrough: timestamp.nullable(),
  /**
   * For timelines, the same stretch of the preceding period, counted with the same rules and
   * filters: from one range length before `window.from` until one range length before `asOf`,
   * so a partly elapsed day or week compares with the same part of its counterpart. Compare
   * only when `coverage` is `complete`. Issues count from Luma's first recorded detection, so
   * an earlier stretch is `not_imported` or `partial`. List its records with the point
   * `previous`. Null for breakdowns.
   */
  previous: z
    .object({
      from: timestamp,
      before: timestamp,
      total: z.number().int().nonnegative(),
      coverage: insightPointCoverageSchema,
    })
    .nullable(),
  asOf: timestamp,
});

const money = z.object({ amount: z.string(), currency: z.string() });

const source = z.object({
  connectionId: z.string().uuid(),
  label: z.string(),
});

const insightRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('order'),
    id: z.string().uuid(),
    number: z.string().nullable(),
    placedAt: timestamp.nullable(),
    status: z.string(),
    fulfillment: z.string(),
    total: money.nullable(),
    sources: z.array(source),
    /** Open issues on the order that need a person; each is a Needs you item. */
    attentionIssueIds: z.array(z.string().uuid()),
  }),
  z.object({
    kind: z.literal('fulfillment'),
    id: z.string().uuid(),
    source,
    workKind: z.string().nullable(),
    status: z.string(),
    signals: z.array(z.string()),
    progressAt: timestamp,
    lastProgressAt: timestamp.nullable(),
    fulfillBy: timestamp.nullable(),
    locationName: z.string().nullable(),
    units: z.string(),
    unit: z.string().nullable(),
    order: z.object({ id: z.string().uuid(), number: z.string().nullable() }),
  }),
  z.object({
    kind: z.literal('stock_position'),
    id: z.string().uuid(),
    ruleId: z.string(),
    sku: z.string(),
    source,
    available: z.number().nullable(),
    minimum: z.number(),
    unit: z.string().nullable(),
    observedAt: timestamp.nullable(),
    /** Why the stock can't be compared, or null when it was usable. */
    unknownReason: z.string().nullable(),
    purchaseOrderIds: z.array(z.string().uuid()),
  }),
  z.object({
    kind: z.literal('case'),
    id: z.string().uuid(),
    class: z.string(),
    severity: z.string().nullable(),
    state: z.enum(caseStates),
    detectedAt: timestamp,
    resolvedAt: timestamp.nullable(),
    resolution: z.enum(['verified', 'human_disposition']).nullable(),
    /** Why a person is needed, when the issue is in Needs you. */
    attention: z
      .enum(['approval', 'manual_intervention', 'uncertainty'])
      .nullable(),
  }),
  z.object({
    kind: z.literal('purchase_order'),
    id: z.string().uuid(),
    reference: z.string(),
    supplierName: z.string(),
    stage: z.string(),
    expectedDate: z.string().nullable(),
    overdue: z.boolean(),
    attention: z.number().int().nonnegative(),
    nextOwner: z.string(),
    createdAt: timestamp,
  }),
]);

export const insightRecordListSchema = z.object({
  chart: insightChartSchema,
  point: z.string().nullable(),
  series: z.string().nullable(),
  /** Every record matching the point and series; equals the chart value read at `asOf`. */
  totalCount: z.number().int().nonnegative(),
  items: z.array(insightRecordSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
  asOf: timestamp,
});

export type InsightChart = z.infer<typeof insightChartSchema>;

export type InsightRange = z.infer<typeof insightRangeSchema>;

export type InsightPoint = z.infer<typeof insightPointSchema>;

export type InsightSource = z.infer<typeof insightSourceSchema>;

export type InsightChartResponse = z.infer<typeof insightChartResponseSchema>;

export type InsightRecord = z.infer<typeof insightRecordSchema>;
