import { createAuditLog } from '@luma/audit/composition';
import type { EffectRegistry } from '@luma/connections';
import {
  createConnectionCoverage,
  createPlaybookGrantReader,
} from '@luma/connections/composition';
import type { VerificationEvaluator } from '@luma/exceptions';
import {
  createCaseMetricReader,
  createOrderAttentionBoundaryReader,
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import type { IdentityService } from '@luma/identity';
import {
  createOrderMetricReader,
  orderStateQueries,
} from '@luma/orders/composition';
import type { ModelGateway, TenantDatabase } from '@luma/platform';
import { createReplenishmentScenarios } from '@luma/procurement';
import {
  createProcurement,
  createProcurementMetricReader,
} from '@luma/procurement/composition';
import {
  createFulfillmentWorkspace,
  createInventoryWorkspace,
  createOperationalMetrics,
  createOperationalSummary,
  createOrderWorkspace,
  createProductWorkspace,
  createRecordExplorer,
} from '@luma/read-models/composition';
import {
  createShippingMethodTemplate,
  shippingMethodPlaybook,
  shippingMethodVocabulary,
} from '@luma/resolution';
import {
  createActivityStore,
  createOperationsOverview,
  createResolutionLearning,
  createShadowEvaluations,
  createWorkspaceActivity,
} from '@luma/resolution/composition';
import {
  compilePlaybook,
  createCodeProcesses,
  createDraftGenerations,
  createDrafts,
  createDraftTestRuns,
  createWorkflows,
  createWorkflowTemplates,
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
  drafts: ReturnType<typeof createDrafts>;
  draftTests: ReturnType<typeof createDraftTestRuns>;
  generation: ReturnType<typeof createDraftGenerations>;
  templates: ReturnType<typeof createWorkflowTemplates>;
  replenishment: ReturnType<typeof createReplenishmentRuntime>;
  codeProcesses: ReturnType<typeof createCodeProcesses>;
  procurement: ReturnType<typeof createProcurement>;
  library: ReturnType<typeof createPersistentPlaybookLibrary>;
  http: {
    shadow: ReturnType<typeof createShadowEvaluations>;
    cases: ReturnType<typeof createDetectionServices>['cases'];
    desk: ReturnType<typeof createDeskServices>;
    workflows: ReturnType<typeof createWorkflows>;
    workflowDrafts: ReturnType<typeof createDrafts>;
    draftTests: ReturnType<typeof createDraftTestRuns>;
    workflowGeneration: ReturnType<typeof createDraftGenerations>;
    workflowTemplates: ReturnType<typeof createWorkflowTemplates>;
    procurement: ReturnType<typeof createProcurement>;
    playbooks: ReturnType<typeof createPersistentPlaybookLibrary>;
    activity: ReturnType<typeof createWorkspaceActivity>;
    learning: ReturnType<typeof createResolutionLearning>;
    operations: ReturnType<typeof createOperationsOverview>;
    metrics: ReturnType<typeof createOperationalMetrics>;
    operationalSummary: ReturnType<typeof createOperationalSummary>;
    records: ReturnType<typeof createRecordExplorer>;
    inventory: ReturnType<typeof createInventoryWorkspace>;
    products: ReturnType<typeof createProductWorkspace>;
    fulfillment: ReturnType<typeof createFulfillmentWorkspace>;
    orders: ReturnType<typeof createOrderWorkspace>;
  };
}

export interface ApplicationOptions {
  database: TenantDatabase;
  identity: IdentityService;
  execution: ExecutionConfiguration;
  replenishmentTransport?: ReplenishmentTransport;
  verifier?: VerificationEvaluator;
  desk?: Parameters<typeof createDeskServices>[3];
  /** Generates workflow drafts from descriptions. Without it, describing workflows is unavailable. */
  modelGateway?: ModelGateway;
  /** Whether the gateway has an EU zero-retention route for authoring, and why not. */
  authoring?: { available: boolean; reason: string | null };
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

  const playbooks = createResolutionPlaybooks(database, identity, safety);
  const templateSources = [
    replenishment.template,
    createShippingMethodTemplate({
      digest: compilePlaybook(shippingMethodPlaybook).digest,
      grants: createPlaybookGrantReader(database),
      library,
      publish: async (context) => {
        await playbooks.publish(context, shippingMethodPlaybook);
      },
    }),
  ];
  const templates = createWorkflowTemplates({
    sources: templateSources,
    refreshContext: identity.refreshContext,
  });
  const drafts = createDrafts(database, {
    refreshContext: identity.refreshContext,
    audit: createAuditLog,
    sources: [
      codeProcesses,
      { vocabulary: replenishment.vocabulary },
      shippingMethodVocabulary,
    ],
    builtIn: [
      replenishment.version.definition.id,
      shippingMethodPlaybook.definition.id,
    ],
    templates: templateSources,
  });
  const draftTests = createDraftTestRuns(database, {
    refreshContext: identity.refreshContext,
    vocabulary: drafts.vocabulary,
    scenarioSources: [createReplenishmentScenarios(replenishment.version)],
  });
  const generation = createDraftGenerations(database, {
    drafts,
    gateway: options.modelGateway ?? null,
    availability: options.authoring ?? {
      available: false,
      reason: 'Describing workflows isn’t set up on this server.',
    },
    refreshContext: identity.refreshContext,
  });
  const workflows = createWorkflows(
    database,
    library,
    identity.refreshContext,
    replenishment.api,
    codeProcesses,
    drafts.blockers,
  );
  const orderQueries = {
    state: orderStateQueries,
    attention: orderAttentionQuery,
    attentionFor: orderAttentionForOrders,
  };

  return {
    codeProcesses,
    replenishment,
    workflows,
    drafts,
    draftTests,
    generation,
    templates,
    procurement,
    detection,
    safety,
    desk,
    playbooks,
    library,
    http: {
      workflows,
      workflowDrafts: drafts,
      draftTests,
      workflowGeneration: generation,
      workflowTemplates: templates,
      procurement,
      shadow: createShadowEvaluations(database, identity.refreshContext),
      cases: detection.cases,
      desk,
      playbooks: library,
      activity: createWorkspaceActivity(database, identity.refreshContext),
      learning: createResolutionLearning(database, identity.refreshContext),
      operationalSummary: createOperationalSummary(database, {
        cases: createCaseMetricReader,
        procurement: createProcurementMetricReader,
        coverage: createConnectionCoverage,
      }),
      metrics: createOperationalMetrics(database, {
        orders: (db) => createOrderMetricReader(db, orderAttentionQuery),
        attentionBoundary: createOrderAttentionBoundaryReader,
        coverage: createConnectionCoverage,
      }),
      operations: createOperationsOverview(
        detection.cases,
        createConnectionCoverage(database),
      ),
      inventory: createInventoryWorkspace(database),
      products: createProductWorkspace(database),
      records: createRecordExplorer(database),
      orders: createOrderWorkspace(
        database,
        orderQueries,
        createActivityStore,
        identity.refreshContext,
      ),
      fulfillment: createFulfillmentWorkspace(
        database,
        orderQueries,
        createActivityStore,
        identity.refreshContext,
      ),
    },
  };
}
