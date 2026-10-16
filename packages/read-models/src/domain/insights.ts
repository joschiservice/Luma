export type InsightPointCoverage = 'complete' | 'partial' | 'not_imported';

export type InsightSourceState =
  | 'complete'
  | 'limited'
  | 'importing'
  | 'stale'
  | 'failing'
  | 'paused'
  | 'disconnected'
  | 'not_synced';

/** One timeline bucket or breakdown category, with a count per series. */
export interface InsightPoint {
  key: string;
  start: string | null;
  end: string | null;
  from: string | null;
  before: string | null;
  values: Record<string, number>;
  total: number;
  coverage: InsightPointCoverage;
}

/** What one connection contributes to a chart, from its commerce sync stream. */
export interface InsightSource {
  connectionId: string;
  label: string;
  system: string | null;
  state: InsightSourceState;
  historyFrom: string | null;
  dataThrough: string | null;
  lastReadAt: string | null;
}

export interface InsightCoverage {
  state: 'complete' | 'partial' | 'stale' | 'unavailable';
  sources: InsightSource[];
  excluded: { reason: string; count: number }[];
}

/** A source read older than this no longer establishes current data. */
const staleAfterMs = 24 * 60 * 60 * 1000;

export const orderSeries = ['open', 'completed', 'cancelled', 'unknown'];

export const caseSeries = [
  'sync_failure',
  'stuck_fulfillment',
  'inventory_mismatch',
  'workflow_failure',
];

/**
 * Time since open work last reported progress, in hours. A bucket includes its lower bound;
 * the last bucket has no upper bound.
 */
export const fulfillmentWaits = [
  { key: 'under_1d', from: 0, before: 24 },
  { key: '1_2d', from: 24, before: 48 },
  { key: '2_7d', from: 48, before: 168 },
  { key: 'over_7d', from: 168, before: null },
] as const;

/** Each open fulfillment counts under its first signal in this order, or `none`. */
export const fulfillmentSeries = ['held', 'overdue', 'stalled', 'none'];

export const stockPoints = [
  'below_no_order',
  'below_with_order',
  'unknown',
  'at_or_above',
];

/** Purchase-order stages in the order work moves through them. Closed and cancelled are done. */
export const procurementPoints = [
  'draft',
  'awaiting_approval',
  'sending',
  'send_failed',
  'awaiting_confirmation',
  'confirmed',
  'changed',
  'partially_received',
  'received',
];

export const procurementSeries = ['overdue', 'not_overdue'];

/** One connection's import of a record type, as the commerce sync owner reports it. */
export interface SourceRead {
  connectionId: string;
  label: string;
  system: string | null;
  connectionStatus: string;
  stream: {
    phase: string;
    paused: boolean;
    blocked: boolean;
    failing: boolean;
    watermark: string | null;
    historyFrom: string | null;
    lastSuccessAt: string | null;
  } | null;
}

/**
 * Classifies what a connection contributes to a chart. Problems that make counts incomplete
 * win over staleness, and staleness over a limited history.
 */
export function sourceState(
  read: SourceRead,
  asOf: string,
  windowFrom: string | null,
): InsightSourceState {
  const stream = read.stream;
  if (['disconnected', 'revoked'].includes(read.connectionStatus))
    return 'disconnected';
  if (!stream) return 'not_synced';
  if (stream.paused || stream.blocked) return 'paused';
  if (stream.failing) return 'failing';
  if (stream.phase === 'backfill' || !stream.watermark) return 'importing';
  if (Date.parse(asOf) - Date.parse(stream.watermark) > staleAfterMs)
    return 'stale';
  if (
    windowFrom &&
    stream.historyFrom &&
    Date.parse(stream.historyFrom) > Date.parse(windowFrom)
  )
    return 'limited';

  return 'complete';
}

/** Describes each source for a chart window; `windowFrom` is null for current-state charts. */
export function insightSources(
  reads: SourceRead[],
  asOf: string,
  windowFrom: string | null,
): InsightSource[] {
  return reads.map((read) => ({
    connectionId: read.connectionId,
    label: read.label,
    system: read.system,
    state: sourceState(read, asOf, windowFrom),
    historyFrom: read.stream?.historyFrom ?? null,
    dataThrough: read.stream?.watermark ?? null,
    lastReadAt: read.stream?.lastSuccessAt ?? null,
  }));
}

/** Summarizes source states. No source in scope means nothing can be counted, not zero. */
export function coverageState(
  sources: InsightSource[],
): InsightCoverage['state'] {
  if (!sources.length) return 'unavailable';
  if (sources.some((source) => !['complete', 'stale'].includes(source.state)))
    return 'partial';
  if (sources.some((source) => source.state === 'stale')) return 'stale';

  return 'complete';
}

/**
 * The oldest complete read across sources: every source's changes before it are counted.
 * Unknown when any source has never completed a read.
 */
export function dataThrough(sources: InsightSource[]) {
  if (!sources.length || sources.some((source) => !source.dataThrough))
    return null;

  return sources
    .map((source) => source.dataThrough!)
    .reduce((oldest, value) =>
      Date.parse(value) < Date.parse(oldest) ? value : oldest,
    );
}

/**
 * Whether imported history and complete reads cover a timeline bucket. A bucket lying wholly
 * before every source's history is `not_imported`; a bucket that starts before some source's
 * history or ends after `through` is `partial`. Sources without an import are reported by the
 * overall coverage instead.
 */
export function pointCoverage(
  bucket: { from: string; before: string },
  sources: InsightSource[],
  through: string | null,
): InsightPointCoverage {
  const from = Date.parse(bucket.from);
  const before = Date.parse(bucket.before);
  const history = sources.map((source) =>
    source.historyFrom ? Date.parse(source.historyFrom) : null,
  );
  if (
    sources.length &&
    sources.every((source) => source.state !== 'not_synced') &&
    history.every((start) => start !== null && start >= before)
  )
    return 'not_imported';
  if (history.some((start) => start !== null && start > from)) return 'partial';
  if (through && before > Date.parse(through)) return 'partial';

  return 'complete';
}

/**
 * Whether Luma's issue records cover a stretch. Issues exist only from Luma's first recorded
 * detection, `since`; before it Luma has no evidence that it was watching, so an earlier stretch
 * is unknown rather than empty. Without any detection nothing establishes when watching began.
 */
export function detectionCoverage(
  span: { from: string; before: string },
  since: string | null,
): InsightPointCoverage {
  if (!since || Date.parse(span.before) <= Date.parse(since))
    return 'not_imported';

  return Date.parse(span.from) < Date.parse(since) ? 'partial' : 'complete';
}

/** Builds points in the given order with every series present, counting `rows`. */
export function countPoints(
  points: {
    key: string;
    start?: string | null;
    end?: string | null;
    from?: string | null;
    before?: string | null;
    coverage?: InsightPointCoverage;
  }[],
  series: string[],
  rows: { point: string; series: string; count: number }[],
): InsightPoint[] {
  return points.map((point) => {
    const values = Object.fromEntries(series.map((id) => [id, 0]));
    for (const row of rows)
      if (row.point === point.key && row.series in values)
        values[row.series]! += row.count;

    return {
      key: point.key,
      start: point.start ?? null,
      end: point.end ?? null,
      from: point.from ?? null,
      before: point.before ?? null,
      values,
      total: Object.values(values).reduce((sum, value) => sum + value, 0),
      coverage: point.coverage ?? 'complete',
    };
  });
}

/** Places a monitored stock position on the stock risk chart. */
export function stockPoint(position: {
  unknownReason: string | null;
  belowMinimum: boolean;
  purchaseOrderIds: string[];
}) {
  if (position.unknownReason) return 'unknown';
  if (!position.belowMinimum) return 'at_or_above';

  return position.purchaseOrderIds.length
    ? 'below_with_order'
    : 'below_no_order';
}
