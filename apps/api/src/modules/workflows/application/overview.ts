import type { CoverageReader } from '#modules/connectors/index';
import type { CaseService } from '#modules/exceptions/index';
import type { TenantContext } from '#modules/identity/index';
import { requireTenant } from '#modules/identity/index';

/**
 * Combines persisted case counts and connection coverage for a rolling 24-hour or seven-day
 * window.
 */
export function createOperationsOverview(
  cases: CaseService,
  coverage: CoverageReader,
  now = () => new Date(),
) {
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

export type OperationsOverviewService = ReturnType<
  typeof createOperationsOverview
>;
