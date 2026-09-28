import { createAuditLog } from '@luma/audit/composition';
import type { EffectRegistry } from '@luma/connections';
import { createConnectionCoverage } from '@luma/connections/composition';
import type { VerificationEvaluator } from '@luma/exceptions';
import {
  createOrderAttentionBoundaryReader,
  createOrderAttentionReader,
} from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import { createOrderMetricReader } from '@luma/orders/composition';
import type { TenantDatabase } from '@luma/platform';
import { createProcurement } from '@luma/procurement/composition';
import {
  createOperationalMetrics,
  createOperationsOverview,
  createResolutionLearning,
  createShadowEvaluations,
  createWorkspaceActivity,
} from '@luma/resolution/composition';
import {
  createCodeProcesses,
  createWorkflows,
} from '@luma/workflows/composition';

import { createAdmissionEligibility } from './admission.js';
import { createPersistentPlaybookLibrary } from './playbook-library.js';
import { createProcurementEffects } from './procurement-effects.js';
import {
  createReplenishmentRuntime,
  type ReplenishmentTransport,
} from './replenishment.js';
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
  workflows: ReturnType<typeof createWorkflows>;
  replenishment: ReturnType<typeof createReplenishmentRuntime>;
  codeProcesses: ReturnType<typeof createCodeProcesses>;
  procurement: ReturnType<typeof createProcurement>;
  library: ReturnType<typeof createPersistentPlaybookLibrary>;
  http: {
    shadow: ReturnType<typeof createShadowEvaluations>;
    cases: ReturnType<typeof createDetectionServices>['cases'];
    desk: ReturnType<typeof createDeskServices>;
    workflows: ReturnType<typeof createWorkflows>;
    procurement: ReturnType<typeof createProcurement>;
    playbooks: ReturnType<typeof createPersistentPlaybookLibrary>;
    activity: ReturnType<typeof createWorkspaceActivity>;
    learning: ReturnType<typeof createResolutionLearning>;
    operations: ReturnType<typeof createOperationsOverview>;
    metrics: ReturnType<typeof createOperationalMetrics>;
  };
}

export interface ApplicationOptions {
  database: TenantDatabase;
  identity: IdentityService;
  execution: ExecutionConfiguration;
  replenishmentTransport?: ReplenishmentTransport;
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
  const procurement = createProcurement(
    database,
    identity.refreshContext,
    createAuditLog,
  );
  const procurementEffects =
    options.execution.kind === 'enabled'
      ? createProcurementEffects(procurement)
      : { resolve: async () => null };
  const combinedEffects: EffectRegistry = {
    resolve: async (context, intent) =>
      (await procurementEffects.resolve(context, intent)) ??
      effects.resolve(context, intent),
  };
  const resolutionEligible = createAdmissionEligibility(detection.diagnoses);
  const safety = createSafetyServices(database, identity, combinedEffects, {
    eligible: (context, step) =>
      step.subject
        ? replenishment.eligible(context, step)
        : resolutionEligible(context, step),
  });
  const desk = createDeskServices(
    database,
    identity,
    combinedEffects,
    options.desk,
  );
  const library = createPersistentPlaybookLibrary(database, identity);

  const replenishment = createReplenishmentRuntime({
    db: database,
    identity,
    procurement,
    safety,
    enabled: options.execution.kind === 'enabled',
    ...(options.replenishmentTransport
      ? { transport: options.replenishmentTransport }
      : {}),
  });
  const codeProcesses = createCodeProcesses(
    database,
    identity,
    options.replenishmentTransport,
  );
  const workflows = createWorkflows(
    database,
    library,
    identity.refreshContext,
    replenishment.api,
    codeProcesses,
  );

  return {
    codeProcesses,
    replenishment,
    workflows,
    procurement,
    detection,
    safety,
    desk,
    playbooks: createResolutionPlaybooks(database, identity, safety),
    library,
    http: {
      workflows,
      procurement,
      shadow: createShadowEvaluations(database, identity.refreshContext),
      cases: detection.cases,
      desk,
      playbooks: library,
      activity: createWorkspaceActivity(database, identity.refreshContext),
      learning: createResolutionLearning(database, identity.refreshContext),
      metrics: createOperationalMetrics(database, {
        orders: createOrderMetricReader,
        attention: createOrderAttentionReader,
        attentionBoundary: createOrderAttentionBoundaryReader,
        coverage: createConnectionCoverage,
      }),
      operations: createOperationsOverview(
        detection.cases,
        createConnectionCoverage(database),
      ),
    },
  };
}
