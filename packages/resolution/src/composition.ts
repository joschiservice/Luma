import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import { compilePlaybook, playbookHash } from '@luma/workflows/composition';

import { createActivityService } from './application/activity.js';
import { createDecisionAssignmentService } from './application/decision-assignments.js';
import type { LearningService, LearningStore } from './application/learning.js';
import { createLearningService } from './application/learning.js';
import { createMeasurementService } from './application/measurement.js';
import { createShadowService } from './application/shadow.js';
import { learningBoundary } from './infrastructure/learning-validation.js';
import { measurementCommandSchema } from './infrastructure/measurement-validation.js';
import { createActivityStore } from './infrastructure/persistence/activity.js';
import { createDecisionAssignmentStore } from './infrastructure/persistence/decision-assignments.js';
import { createLearningStore } from './infrastructure/persistence/learning.js';
import { createMeasurementStore } from './infrastructure/persistence/measurement.js';
import { createShadowStore } from './infrastructure/persistence/shadow.js';
import { shadowBoundary } from './infrastructure/shadow-validation.js';

export { createExceptionActivities } from './application/runtime.js';

export { createResolutionMetricReader } from './infrastructure/persistence/measurement.js';

export { createOperationsOverview } from './application/overview.js';

export { createDeskStore } from './infrastructure/persistence/desk.js';

export { createDeskService } from './application/desk.js';

/** Composes freshly authorized measurement commands with the append-only evidence ledger. */
export function createResolutionMeasurements(
  db: TenantDatabase,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
  now = () => new Date(),
) {
  return createMeasurementService({
    store: createMeasurementStore(db, now),
    refreshContext,
    parse: (input) => measurementCommandSchema.parse(input),
  });
}

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

export { createActivityStore } from './infrastructure/persistence/activity.js';

/**
 * Composes Needs you assignments. `pending` must answer from the decision queue, and `members`
 * from identity, both for the refreshed reader.
 */
export function createDecisionAssignments(
  db: TenantDatabase,
  deps: Omit<
    Parameters<typeof createDecisionAssignmentService>[0],
    'store' | 'now'
  >,
  now: () => Date = () => new Date(),
) {
  return createDecisionAssignmentService({
    ...deps,
    store: createDecisionAssignmentStore(db),
    now,
  });
}
