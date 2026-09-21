import type { TenantDatabase } from '#modules/platform/index';
import { learningBoundary } from '#modules/workflows/api/learning';
import type {
  LearningService,
  LearningStore,
} from '#modules/workflows/application/learning';
import { createLearningService } from '#modules/workflows/application/learning';
import type { PlaybookDependencies } from '#modules/workflows/application/playbook';
import { createPlaybookService } from '#modules/workflows/application/playbook';
import { createLearningStore } from '#modules/workflows/infrastructure/persistence/learning';
import {
  activationRequestSchema,
  compilePlaybook,
  parsePlaybookSnapshot,
  playbookHash,
} from '#modules/workflows/infrastructure/playbooks/schema';
import { createPlaybookStore } from '#modules/workflows/infrastructure/playbooks/store';

export { createExceptionActivities } from '#modules/workflows/application/runtime';

export {
  createDeskWorkflowReader,
  createExceptionClient,
  createExceptionWorker,
} from '#modules/workflows/infrastructure/temporal/runtime';

export type { TemporalSettings } from '#modules/workflows/infrastructure/temporal/runtime';

export { createOperationsOverview } from '#modules/workflows/application/overview';

export { operationsRoutes } from '#modules/workflows/api/overview';

export { createDeskStore } from '#modules/workflows/infrastructure/persistence/desk';

export { createDeskService } from '#modules/workflows/application/desk';

export { deskRoutes, registerDeskEvents } from '#modules/workflows/api/desk';

/**
 * Creates persistent playbook services with compilation, snapshot validation, and action-
 * admission boundaries.
 */
export function createPlaybooks(
  db: TenantDatabase,
  dependencies: Pick<
    PlaybookDependencies,
    'admission' | 'provisioning' | 'refreshContext' | 'parseAction'
  >,
  now: () => Date = () => new Date(),
) {
  return createPlaybookService({
    ...dependencies,
    store: createPlaybookStore(db),
    compile: compilePlaybook,
    parseSnapshot: parsePlaybookSnapshot,
    parseActivation: (input) => activationRequestSchema.parse(input),
    hash: playbookHash,
    now,
  });
}

export {
  compilePlaybook,
  definePlaybook,
  parsePlaybookCode,
  printPlaybookCode,
} from '#modules/workflows/infrastructure/playbooks/schema';

export { learningRoutes } from '#modules/workflows/api/learning';

/**
 * Creates persistent resolution learning with fresh authorization and validated commands and
 * responses.
 */
export function createResolutionLearning(
  db: import('#modules/platform/index').TenantDatabase,
  refreshContext: (
    context: import('#modules/identity/index').TenantContext,
  ) => Promise<import('#modules/identity/index').TenantContext>,
  now: () => Date = () => new Date(),
): LearningService {
  return createLearningCommands(createLearningStore(db, now), refreshContext);
}

/** Composes authorized learning commands with validation and an atomic storage adapter. */
export function createLearningCommands(
  store: LearningStore,
  refreshContext: (
    context: import('#modules/identity/index').TenantContext,
  ) => Promise<import('#modules/identity/index').TenantContext>,
): LearningService {
  return createLearningService({ store, refreshContext, ...learningBoundary });
}
