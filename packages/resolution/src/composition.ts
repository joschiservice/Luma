import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { compilePlaybook, playbookHash } from '@luma/workflows/composition';

import { createActivityService } from './application/activity.js';
import type { LearningService, LearningStore } from './application/learning.js';
import { createLearningService } from './application/learning.js';
import { createShadowService } from './application/shadow.js';
import { learningBoundary } from './infrastructure/learning-validation.js';
import { createActivityStore } from './infrastructure/persistence/activity.js';
import { createLearningStore } from './infrastructure/persistence/learning.js';
import { createShadowStore } from './infrastructure/persistence/shadow.js';
import { shadowBoundary } from './infrastructure/shadow-validation.js';

export { createExceptionActivities } from './application/runtime.js';

export { createOperationsOverview } from './application/overview.js';

export { createDeskStore } from './infrastructure/persistence/desk.js';

export { createDeskService } from './application/desk.js';

/**
 * Creates persistent resolution learning with fresh authorization and validated commands and
 * responses.
 */
export function createResolutionLearning(
  db: import('@luma/platform').TenantDatabase,
  refreshContext: (
    context: import('@luma/identity').TenantContext,
  ) => Promise<import('@luma/identity').TenantContext>,
  now: () => Date = () => new Date(),
): LearningService {
  return createLearningCommands(createLearningStore(db, now), refreshContext);
}

/** Composes authorized learning commands with validation and an atomic storage adapter. */
export function createLearningCommands(
  store: LearningStore,
  refreshContext: (
    context: import('@luma/identity').TenantContext,
  ) => Promise<import('@luma/identity').TenantContext>,
): LearningService {
  return createLearningService({ store, refreshContext, ...learningBoundary });
}

/** Composes the workspace activity reader with refreshed membership. */
export function createWorkspaceActivity(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
) {
  return createActivityService(createActivityStore(db), refreshContext);
}

/** Composes persistent Shadow evaluations without an execution registry. */
export function createShadowEvaluations(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now: () => Date = () => new Date(),
) {
  return createShadowService({
    store: createShadowStore(db, { compilePlaybook, playbookHash }),
    refreshContext,
    now,
    ...shadowBoundary,
  });
}

export {
  createPlaybooks,
  compilePlaybook,
  definePlaybook,
  parsePlaybookCode,
  printPlaybookCode,
  createPlaybookLibrary,
  createPlaybookLibraryStore,
  createPlaybookActivations,
  createPlaybookStore,
  activationRequestSchema,
  createPlaybookService,
  parsePlaybookSnapshot,
  playbookHash,
} from '@luma/workflows/composition';

export { createOperationalMetrics } from './infrastructure/metrics.js';
