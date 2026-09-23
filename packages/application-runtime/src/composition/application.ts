import type { EffectRegistry } from '@luma/connections';
import { createConnectionCoverage } from '@luma/connections/composition';
import type { VerificationEvaluator } from '@luma/exceptions';
import type { IdentityService } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import {
  createOperationsOverview,
  createResolutionLearning,
  createWorkspaceActivity,
} from '@luma/resolution/composition';

import { createAdmissionEligibility } from './admission.js';
import { createPersistentPlaybookLibrary } from './playbook-library.js';
import {
  createDeskServices,
  createDetectionServices,
  createResolutionPlaybooks,
  createSafetyServices,
} from './services.js';

export type ExecutionConfiguration =
  { kind: 'disabled' } | { kind: 'enabled'; effects: EffectRegistry };

export interface ApplicationServices {
  detection: ReturnType<typeof createDetectionServices>;
  safety: ReturnType<typeof createSafetyServices>;
  desk: ReturnType<typeof createDeskServices>;
  playbooks: ReturnType<typeof createResolutionPlaybooks>;
  library: ReturnType<typeof createPersistentPlaybookLibrary>;
  http: {
    cases: ReturnType<typeof createDetectionServices>['cases'];
    desk: ReturnType<typeof createDeskServices>;
    playbooks: ReturnType<typeof createPersistentPlaybookLibrary>;
    activity: ReturnType<typeof createWorkspaceActivity>;
    learning: ReturnType<typeof createResolutionLearning>;
    operations: ReturnType<typeof createOperationsOverview>;
  };
}

export interface ApplicationOptions {
  database: TenantDatabase;
  identity: IdentityService;
  execution: ExecutionConfiguration;
  verifier?: VerificationEvaluator;
  desk?: Parameters<typeof createDeskServices>[3];
}

/**
 * Assembles tenant application services without opening resources or provisioning data.
 * Execution requires an explicit effect registry; disabled execution cannot resolve effects.
 */
export function createApplicationServices(
  options: ApplicationOptions,
): ApplicationServices {
  const { database, identity } = options;
  const effects =
    options.execution.kind === 'enabled'
      ? options.execution.effects
      : { resolve: async () => null };
  const detection = createDetectionServices(
    database,
    undefined,
    options.verifier,
  );
  const safety = createSafetyServices(database, identity, effects, {
    eligible: createAdmissionEligibility(detection.diagnoses),
  });
  const desk = createDeskServices(database, identity, effects, options.desk);
  const library = createPersistentPlaybookLibrary(database, identity);

  return {
    detection,
    safety,
    desk,
    playbooks: createResolutionPlaybooks(database, identity, safety),
    library,
    http: {
      cases: detection.cases,
      desk,
      playbooks: library,
      activity: createWorkspaceActivity(database, identity.refreshContext),
      learning: createResolutionLearning(database, identity.refreshContext),
      operations: createOperationsOverview(
        detection.cases,
        createConnectionCoverage(database),
      ),
    },
  };
}
