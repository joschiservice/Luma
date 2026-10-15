import type { InstalledConnection } from './installation.js';

export interface ConnectionCoverage {
  /** Next freshness boundary for the observed capabilities, when available. */
  nextRefreshAt?: string | null;
  health?:
    | 'healthy'
    | 'delayed'
    | 'failing'
    | 'access_lost'
    | 'importing'
    | 'disconnected';
  streams?: {
    recordType: string;
    lastSuccessfulAt: string | null;
    lastError: string | null;
    issueIds: string[];
  }[];
  id: string;
  label: string;
  status: InstalledConnection['status'];
  /** Latest observation across permitted, granted reads, or null if none exist. */
  lastObservedAt: string | null;
  /** Unobserved if any read is missing; stale if any read is older than 24 hours. */
  freshness: 'fresh' | 'stale' | 'unobserved';
}

export interface CapabilityObservation {
  capability: string;
  observedAt: string;
}

const freshnessWindowMs = 24 * 60 * 60 * 1000;

/**
 * Summarizes permitted, granted reads using the latest observation per capability.
 * Supply valid timestamps at or before `asOf`. Exactly 24 hours old is still fresh;
 * no reads or a missing observation makes coverage unobserved.
 */
export function summarizeConnectionCoverage(
  connection: InstalledConnection,
  observations: readonly CapabilityObservation[],
  asOf: string,
): ConnectionCoverage {
  const reads = connection.granted.filter(
    (capability) =>
      capability.endsWith('.read') &&
      connection.permissions.includes(capability),
  );
  const times = observations
    .filter((observation) =>
      reads.some((read) => read === observation.capability),
    )
    .map((observation) => Date.parse(observation.observedAt));
  const missing =
    reads.length === 0 ||
    reads.some(
      (capability) =>
        !observations.some(
          (observation) => observation.capability === capability,
        ),
    );
  let freshness: ConnectionCoverage['freshness'] = 'fresh';

  if (missing) {
    freshness = 'unobserved';
  } else if (Math.min(...times) < Date.parse(asOf) - freshnessWindowMs) {
    freshness = 'stale';
  }

  return {
    health:
      connection.status === 'revoked'
        ? 'access_lost'
        : connection.status === 'disconnected'
          ? 'disconnected'
          : connection.status === 'degraded'
            ? 'failing'
            : freshness === 'stale'
              ? 'delayed'
              : missing || connection.status === 'pending'
                ? 'importing'
                : 'healthy',
    nextRefreshAt: times.some(
      (time) => time + freshnessWindowMs + 1 > Date.parse(asOf),
    )
      ? new Date(
          Math.min(
            ...times
              .map((time) => time + freshnessWindowMs + 1)
              .filter((time) => time > Date.parse(asOf)),
          ),
        ).toISOString()
      : null,
    id: connection.id,
    label: connection.label,
    status: connection.status,
    lastObservedAt: times.length
      ? new Date(Math.max(...times)).toISOString()
      : null,
    freshness,
  };
}
