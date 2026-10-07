import type { ConnectionMetricItem } from '@luma/connections';
import { connectionMetricDefinitions } from '@luma/connections';
import type { CaseMetricItem } from '@luma/exceptions';
import { caseMetricDefinitions } from '@luma/exceptions';
import type { Permission, TenantContext } from '@luma/identity';
import type { OperationalMetricRead } from '@luma/platform';
import type {
  PurchaseOrderMetricItem,
  StockMetricItem,
} from '@luma/procurement';
import {
  procurementMetricDefinitions,
  stockMetricDefinitions,
} from '@luma/procurement';
import type {
  MeasurementEnvironment,
  ResolutionMetricItem,
} from '@luma/resolution';
import { resolutionMetricDefinitions } from '@luma/resolution';

export const operationalMetricDefinitions = [
  ...caseMetricDefinitions,
  ...resolutionMetricDefinitions,
  ...stockMetricDefinitions,
  ...procurementMetricDefinitions,
  ...connectionMetricDefinitions,
];

/**
 * The read permission each metric family needs, by the first segment of the metric ID.
 * Connection health has no read permission of its own and is shown to every reader.
 */
export const metricFamilyPermissions: Partial<Record<string, Permission>> = {
  resolution: 'issues.read',
  cases: 'issues.read',
  inventory: 'inventory.read',
  procurement: 'procurement.read',
};

export interface OperationalSummaryRequest {
  definitionVersion: 2;
  metrics: string[];
  scope?:
    | {
        environment?: MeasurementEnvironment | undefined;
        window?: '24h' | '7d' | undefined;
        connectionId?: string | undefined;
        supplierId?: string | undefined;
        authority?: 'luma' | 'external' | undefined;
      }
    | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  asOf?: string | undefined;
  snapshot?: string | undefined;
}

export type OperationalCohortItem =
  | ResolutionMetricItem
  | CaseMetricItem
  | StockMetricItem
  | PurchaseOrderMetricItem
  | ConnectionMetricItem;

export interface OperationalSummaryResponse {
  definitionVersion: 2;
  scope: NonNullable<OperationalSummaryRequest['scope']>;
  asOf: string;
  readAt: string;
  snapshot: string;
  timezone: 'UTC';
  nextRefreshAt: string | null;
  limit: number;
  offset: number;
  metrics: OperationalMetricRead<OperationalCohortItem>[];
  /**
   * Requested metric IDs whose family the reader can't read. They keep their place in `metrics`
   * with unavailable coverage, no value and no records.
   */
  hidden: string[];
}

/**
 * Reads selected domain metrics and their paginated cohorts in one authorized snapshot. Metrics
 * whose family needs a permission the reader lacks are withheld rather than failing the read.
 */
export type OperationalSummary = (
  context: TenantContext,
  request: OperationalSummaryRequest,
) => Promise<OperationalSummaryResponse>;
