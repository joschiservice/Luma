import type { TenantContext } from '#modules/identity/index';
import type { InstalledConnection } from '#modules/connectors/domain/installation';
export interface ConnectionCoverage {
  id: string;
  label: string;
  status: InstalledConnection['status'];
  lastObservedAt: string | null;
  freshness: 'fresh' | 'stale' | 'unobserved';
}
export type CoverageReader = (
  context: TenantContext,
  asOf: string,
) => Promise<ConnectionCoverage[]>;
