import type { CoverageReader } from '@luma/connections';
import type { CaseService } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import { requireTenant } from '@luma/identity';

/**
 * Combines persisted case counts and connection coverage for a rolling 24-hour or seven-day
 * window.
 */
export function createOperationsOverview(
  cases: CaseService,
  coverage: CoverageReader,
  now = () => new Date(),
): OperationsOverviewService {
  return async (context: TenantContext, window: '24h' | '7d') => {
    requireTenant(context, context.tenantId);
    const end = now().toISOString();
    const start = new Date(
      Date.parse(end) - (window === '7d' ? 7 : 1) * 86400000,
    ).toISOString();
    const [summary, connections] = await Promise.all([
      cases.overview(context, start, end),
      coverage(context, end),
    ]);

    return {
      ...summary,
      connections,
      generatedAt: end,
      window: { start, end },
      freshnessThresholdHours: 24 as const,
      // Verified resolutions do not establish eligibility or absence of human work.
      automaticallyResolved: null,
      automation: null,
    };
  };
}

/** Reads case totals and connection coverage for the requested reporting window. */
export type OperationsOverviewService = (
  context: TenantContext,
  window: '24h' | '7d',
) => Promise<
  Awaited<ReturnType<CaseService['overview']>> & {
    connections: Awaited<ReturnType<CoverageReader>>;
    generatedAt: string;
    window: { start: string; end: string };
    freshnessThresholdHours: 24;
    automaticallyResolved: null;
    automation: null;
  }
>;
