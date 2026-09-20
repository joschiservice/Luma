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

import { createPlaybookService } from '#modules/workflows/application/playbook';
import type { PlaybookDependencies } from '#modules/workflows/application/playbook';
import type { TenantDatabase } from '#modules/platform/index';
import { createPlaybookStore } from '#modules/workflows/infrastructure/playbook-store';
import {
  compilePlaybook,
  parsePlaybookSnapshot,
  activationRequestSchema,
  playbookHash,
} from '#modules/workflows/infrastructure/playbook-schema';
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
  definePlaybook,
  compilePlaybook,
  printPlaybookCode,
  parsePlaybookCode,
} from '#modules/workflows/infrastructure/playbook-schema';
