import { createAuditLog } from '@luma/audit/composition';
import { createConnectionCoverage } from '@luma/connections/composition';
import { createPendingStockSyncReader } from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import {
  createOperationsOverview,
  createResolutionLearning,
  createResolutionMeasurements,
  createResolutionMetricReader,
  createShadowEvaluations,
  createWorkspaceActivity,
} from '@luma/resolution/composition';

import type { createDetectionServices } from './services.js';

/**
 * Composes the resolution services only the API serves: workspace activity, learning,
 * measurements, the operations overview over `cases` and shadow evaluations. No other owner
 * depends on them.
 */
export function createResolutionServices(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext'>;
  cases: ReturnType<typeof createDetectionServices>['cases'];
}): {
  activity: ReturnType<typeof createWorkspaceActivity>;
  learning: ReturnType<typeof createResolutionLearning>;
  measurements: ReturnType<typeof createResolutionMeasurements>;
  operations: ReturnType<typeof createOperationsOverview>;
  shadow: ReturnType<typeof createShadowEvaluations>;
} {
  const { database, identity } = options;

  return {
    activity: createWorkspaceActivity(
      database,
      identity.refreshContext,
      createAuditLog(database),
    ),
    learning: createResolutionLearning(database, identity.refreshContext),
    measurements: createResolutionMeasurements(
      database,
      identity.refreshContext,
    ),
    operations: createOperationsOverview(
      options.cases,
      createConnectionCoverage(database),
      () => new Date(),
      createResolutionMetricReader(database),
      createPendingStockSyncReader(database),
    ),
    shadow: createShadowEvaluations(database, identity.refreshContext),
  };
}
