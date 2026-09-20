export { createExceptionActivities } from '#modules/workflows/application/runtime';
export {
  createExceptionWorker,
  createExceptionClient,
  createDeskWorkflowReader,
} from '#modules/workflows/infrastructure/runtime';
export type { TemporalSettings } from '#modules/workflows/infrastructure/runtime';

export { createOperationsOverview } from '#modules/workflows/application/overview';
export { operationsRoutes } from '#modules/workflows/api/overview';
export { createDeskStore } from '#modules/workflows/infrastructure/desk';
export { createDeskService } from '#modules/workflows/application/desk';
export { deskRoutes, registerDeskEvents } from '#modules/workflows/api/desk';

import { createLearningService } from '#modules/workflows/application/learning';
import { createLearningStore } from '#modules/workflows/infrastructure/learning';
import { learningBoundary } from '#modules/workflows/api/learning';
export { learningRoutes } from '#modules/workflows/api/learning';
export function createResolutionLearning(
  db: import('#modules/platform/index').TenantDatabase,
  refreshContext: (
    context: import('#modules/identity/index').TenantContext,
  ) => Promise<import('#modules/identity/index').TenantContext>,
  now: () => Date = () => new Date(),
) {
  return createLearningService({
    store: createLearningStore(db, now),
    refreshContext,
    ...learningBoundary,
  });
}
