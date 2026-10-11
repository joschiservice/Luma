import type { ReturnDetail } from '@luma/api-contract';

/** A read is usable only while access is healthy and its timestamp is within the last day. */
export function returnReadIsFresh(
  source: ReturnDetail,
  observedAt: string,
  now: string,
): boolean {
  const at = Date.parse(observedAt);
  const evaluated = Date.parse(now);

  return (
    Number.isFinite(at) &&
    Number.isFinite(evaluated) &&
    at <= evaluated &&
    evaluated - at <= 24 * 3_600_000 &&
    source.source?.status === 'active' &&
    source.source.access === 'granted' &&
    !source.source.failing
  );
}

/** Financial confirmation requires recent return and payment reads with healthy access. */
export function returnEvidenceFreshness(
  source: ReturnDetail | undefined,
  now: string,
): 'fresh' | 'stale' | 'missing' {
  if (!source) return 'missing';

  return returnReadIsFresh(source, source.item.observedAt, now) &&
    source.refunds.every((refund) =>
      returnReadIsFresh(source, refund.observedAt, now),
    )
    ? 'fresh'
    : 'stale';
}
