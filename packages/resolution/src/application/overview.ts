import type { CoverageReader } from '@luma/connections';
import type { CaseService } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';

import type { ResolutionMetricReader } from './measurement.js';

/**
 * Combines persisted case counts and connection coverage for a rolling 24-hour or seven-day
 * window. Explicit bounds select a brief verification interval; fixed-window measurement
 * is omitted because its detection cohort cannot represent a variable interval.
 */
export function createOperationsOverview(
  cases: CaseService,
  coverage: CoverageReader,
  now = () => new Date(),
  measurementReader?: ResolutionMetricReader,
  pendingStock?: (
    context: TenantContext,
  ) => Promise<{ count: number; until: string | null } | undefined>,
): OperationsOverviewService {
  return async (
    context: TenantContext,
    window: '24h' | '7d',
    asOf?: Date,
    since?: Date,
  ) => {
    requireTenant(context, context.tenantId);
    const end = (asOf ?? now()).toISOString();
    const readAt = since ? now().toISOString() : end;
    const start = (
      since ?? new Date(Date.parse(end) - (window === '7d' ? 7 : 1) * 86400000)
    ).toISOString();
    const [summary, connections, metrics, pending] = await Promise.all([
      cases.overview(context, start, end, readAt),
      coverage(context, readAt),
      since
        ? undefined
        : measurementReader?.(context.tenantId, end, {
            environment: 'live',
            window,
          }),
      pendingStock?.(context),
    ]);

    const autonomous = metrics?.find(
      (m) => m.definition.id === 'resolution.autonomous',
    );
    const eligible = metrics?.find(
      (m) => m.definition.id === 'resolution.eligible',
    );
    const measured =
      autonomous && eligible
        ? {
            environment: 'live' as const,
            countingUnit: 'incident' as const,
            coverage: autonomous.coverage,
            explanation: autonomous.coverageExplanation,
            eligible: eligible.observedCount,
            verified: metrics!.find(
              (m) => m.definition.id === 'resolution.verified',
            )!.observedCount,
            autonomous: autonomous.observedCount,
            human: metrics!.find((m) => m.definition.id === 'resolution.human')!
              .observedCount,
            unknownEligibility: eligible.unknownCount,
            unknownAttribution: autonomous.breakdown.find(
              (b) => b.reason === 'unknown_attribution',
            )!.count,
            unknownEnvironment: autonomous.breakdown.find(
              (b) => b.reason === 'unknown_environment',
            )!.count,
            pending: metrics!.find(
              (m) => m.definition.id === 'resolution.pending',
            )!.observedCount,
            dataThrough: null,
          }
        : undefined;

    return {
      ...summary,
      connections,
      ...(pending ? { pendingStock: pending } : {}),
      generatedAt: readAt,
      window: { start, end },
      freshnessThresholdHours: 24 as const,
      measurement: measured,
      automaticallyResolved:
        autonomous?.coverage === 'complete' ? autonomous.observedCount : null,
      automation:
        autonomous?.coverage === 'complete' && eligible
          ? {
              numerator: autonomous.observedCount,
              denominator: eligible.observedCount,
            }
          : null,
    };
  };
}

/** Reads case totals and connection coverage for the requested reporting window. */
export type OperationsOverviewService = (
  context: TenantContext,
  window: '24h' | '7d',
  asOf?: Date,
  since?: Date,
) => Promise<
  Awaited<ReturnType<CaseService['overview']>> & {
    pendingStock?: { count: number; until: string | null };
    connections: Awaited<ReturnType<CoverageReader>>;
    generatedAt: string;
    window: { start: string; end: string };
    freshnessThresholdHours: 24;
    automaticallyResolved: number | null;
    automation: { numerator: number; denominator: number } | null;
    measurement?:
      | {
          environment: 'live';
          countingUnit: 'incident';
          coverage: 'complete' | 'partial' | 'unavailable';
          explanation: string;
          eligible: number;
          verified: number;
          autonomous: number;
          human: number;
          unknownEligibility: number;
          unknownAttribution: number;
          unknownEnvironment: number;
          pending: number;
          dataThrough: null;
        }
      | undefined;
  }
>;
