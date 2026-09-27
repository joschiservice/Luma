import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';

import { createWorkflowCatalog } from './application/catalog.js';
import type { PlaybookDependencies } from './application/playbook.js';
import { createPlaybookService } from './application/playbook.js';
import type { PlaybookLibrary } from './application/playbook-library.js';
import { createWorkflowTriggers } from './application/triggers.js';
import {
  compilePublishedWorkflow,
  createWorkflowCatalogStore,
} from './infrastructure/catalog.js';
import {
  activationRequestSchema,
  compilePlaybook,
  parsePlaybookSnapshot,
  playbookHash,
} from './infrastructure/playbooks/schema.js';
import { createPlaybookStore } from './infrastructure/playbooks/store.js';
import { parseProcessSnapshot } from './infrastructure/process-schema.js';
import { createWorkflowTriggerStore } from './infrastructure/triggers.js';

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
} from './infrastructure/playbooks/schema.js';

export { createPlaybookLibrary } from './application/playbook-library.js';

export { createPlaybookLibraryStore } from './infrastructure/playbooks/library.js';

export { createPlaybookActivations } from './application/playbook-activations.js';

export { createPlaybookStore } from './infrastructure/playbooks/store.js';

export { activationRequestSchema } from './infrastructure/playbooks/schema.js';

export { createPlaybookService, parsePlaybookSnapshot, playbookHash };

export {
  defineWorkflow,
  compileWorkflow,
  printWorkflowCode,
  parseWorkflowCode,
} from './infrastructure/workflow-schema.js';

export { compileProcessWorkflow } from './infrastructure/process-schema.js';

export { runProcess } from './application/process-runtime.js';

export { createProcessActivities } from './application/process-activities.js';

export { createProcessStepStore } from './infrastructure/process-store.js';

export type {
  ProcessActivities,
  ProcessClock,
  ProcessProgress,
} from './application/process-runtime.js';

export type {
  ProcessRun,
  ProcessStep,
  ProcessStepOutput,
  ProcessWorkflowVersion,
} from './domain/process.js';

/** Composes the catalog with refreshed membership and shared resolution admission controls. */
export function createWorkflows(
  db: TenantDatabase,
  legacy: PlaybookLibrary,
  refreshContext: (context: TenantContext) => Promise<TenantContext>,
) {
  return createWorkflowCatalog({
    triggers: createWorkflowTriggers({
      store: createWorkflowTriggerStore(db),
      refreshContext,
      hash: playbookHash,
      id: randomUUID,
      now: () => new Date(),
      parseSnapshot: (input, version) => {
        if (version.format === 'workflow/2')
          return parseProcessSnapshot(input, version);
        const [eligibility, action, approval, verification, recovery] =
          version.steps;

        return parsePlaybookSnapshot(input, {
          definition: version.definition,
          version: version.version,
          digest: version.digest,
          compatibility: { interpreter: 'resolution-playbook/0', admission: 1 },
          provenance: version.provenance,
          ir: {
            schemaVersion: 1,
            inputs: version.inputs,
            evidence: version.context,
            eligibility,
            action,
            approval,
            verification,
            recovery,
          },
        });
      },
    }),
    store: createWorkflowCatalogStore(db),
    legacy,
    compile: compilePublishedWorkflow,
    refreshContext,
  });
}
