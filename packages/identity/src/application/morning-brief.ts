import type { TenantContext } from '../domain/context.js';

/** Home's bounded, authorized report snapshot, read without running providers or models. */
export interface MorningBriefContent {
  start: string;
  end: string;
  attention: number;
  /** Null when the member cannot read issues. */
  active: number | null;
  /** Independent verification only; null when the member cannot read issues. */
  verified: number | null;
  partial: boolean;
  decisions: { label: string; link: string }[];
  cases: { label: string; link: string; verified: boolean }[];
}

/** The release and existing operational readers used by the daily notification scheduler. */
export interface MorningBriefSource {
  enabled(tenantId: string): Promise<boolean>;
  read(
    context: TenantContext,
    asOf: Date,
    start: Date,
  ): Promise<MorningBriefContent | null>;
}

/**
 * Local date and wall clock time. Comparing minutes sends once after the chosen time, including
 * a skipped spring-forward hour; the local-date queue key deduplicates a repeated autumn hour.
 */
export function morningBriefClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;

  return {
    day: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

interface BriefCase {
  id: string;
  summary: string;
}

/** Public owner readers; no provider reads or derived evidence storage is introduced. */
export interface MorningBriefReaders {
  decisions(context: TenantContext): Promise<{
    totalCount: number;
    items: { id: string; title: string }[];
    sources: { state: 'available' | 'unavailable' }[];
  }>;
  overview(
    context: TenantContext,
    asOf: Date,
    start: Date,
  ): Promise<{
    window: { start: string; end: string };
    activeCount: number;
    verifiedResolutions: number;
    verifiedCases?: BriefCase[];
    measurement?:
      { coverage: 'complete' | 'partial' | 'unavailable' } | undefined;
  }>;
  active(context: TenantContext): Promise<{ items: BriefCase[] }>;
  origin: string;
}

/**
 * Composes Home's current decision/case readers and exact since-last-brief verification window. Only
 * independent verification counts as an outcome; absence of read permission is withheld,
 * never shown as zero. Empty complete snapshots produce no notification.
 */
export function createMorningBriefReader(readers: MorningBriefReaders) {
  return async (
    context: TenantContext,
    asOf: Date,
    start: Date,
  ): Promise<MorningBriefContent | null> => {
    const [decisions, overview, active] = await Promise.all([
      readers.decisions(context),
      context.permissions.has('issues.read')
        ? readers.overview(context, asOf, start)
        : null,
      context.permissions.has('issues.read') ? readers.active(context) : null,
    ]);
    const partial =
      decisions.sources.some((source) => source.state === 'unavailable') ||
      (overview?.measurement?.coverage !== undefined &&
        overview.measurement.coverage !== 'complete');
    if (
      !partial &&
      decisions.totalCount === 0 &&
      (overview?.activeCount ?? 0) === 0 &&
      (overview?.verifiedResolutions ?? 0) === 0
    )
      return null;
    const base = `${readers.origin}/app/${context.tenantId}`;

    return {
      start: overview?.window.start ?? start.toISOString(),
      end: overview?.window.end ?? asOf.toISOString(),
      attention: decisions.totalCount,
      active: overview?.activeCount ?? null,
      verified: overview?.verifiedResolutions ?? null,
      partial,
      decisions: decisions.items.map((item) => ({
        label: item.title,
        link: `${base}/needs-you?item=${encodeURIComponent(item.id)}`,
      })),
      cases: [
        ...(overview?.verifiedCases ?? []).map((item) => ({
          label: item.summary,
          link: `${base}/exceptions/${item.id}/detail`,
          verified: true,
        })),
        ...(active?.items ?? []).map((item) => ({
          label: item.summary,
          link: `${base}/exceptions/${item.id}/detail`,
          verified: false,
        })),
      ],
    };
  };
}
