import type { ConnectionMetricItem } from '@luma/connections';
import { connectionMetricDefinitions } from '@luma/connections';
import type { CaseMetricItem } from '@luma/exceptions';
import { caseMetricDefinitions } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
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
}

/** Reads selected domain metrics and their paginated cohorts in one authorized snapshot. */
export type OperationalSummary = (
  context: TenantContext,
  request: OperationalSummaryRequest,
) => Promise<OperationalSummaryResponse>;
