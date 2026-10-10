import { randomBytes } from 'node:crypto';

import { createWorkspaceAssistant } from '@luma/assistant/composition';
import { createAuditLog } from '@luma/audit/composition';
import type {
  ConnectionManagement,
  EffectRegistry,
  ProviderCatalog,
} from '@luma/connections';
import {
  createConnectionCoverage,
  createPlaybookGrantReader,
  createSourceAuthority,
  type InstalledPurchaseOrderRuntime,
} from '@luma/connections/composition';
import type { VerificationEvaluator } from '@luma/exceptions';
import {
  caseDecisionQuery,
  caseTimelineQuery,
  createCaseMetricReader,
  createOrderAttentionBoundaryReader,
  orderAttentionForOrders,
  orderAttentionQuery,
} from '@luma/exceptions/composition';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  createOrderMetricReader,
  orderStateQueries,
} from '@luma/orders/composition';
import type {
  ModelGateway,
  Observability,
  TenantDatabase,
} from '@luma/platform';
import { createReplenishmentScenarios } from '@luma/procurement';
import {
  createProcurement,
  createProcurementMetricReader,
  createStockRiskReader,
  createSupplierCommitmentService,
  type SupplierCommitments,
} from '@luma/procurement/composition';
import {
  appDecisionProvider,
  createCustomerWorkspace,
  createDecisionQueue,
  createFulfillmentWorkspace,
  createInsights,
  createInventoryWorkspace,
  createOperationalMetrics,
  createOperationalSummary,
  createOrderWorkspace,
  createProcurementContext,
  createProductWorkspace,
  createRecordExplorer,
  createReturnWorkspace,
  replenishmentDecisionProvider,
  supplierCommitmentDecisionProvider,
  workflowHandoverDecisionProvider,
} from '@luma/read-models/composition';
import {
  createShippingMethodTemplate,
  shippingMethodPlaybook,
  shippingMethodVocabulary,
} from '@luma/resolution';
import {
  createActivityStore,
  createDecisionAssignments,
  createOperationsOverview,
  createResolutionLearning,
  createResolutionMeasurements,
  createResolutionMetricReader,
  createShadowEvaluations,
  createWorkspaceActivity,
  createWorkspacePeople,
} from '@luma/resolution/composition';
import type { CaseWorkflowAdapter } from '@luma/workflows';
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
import {
  createCaseWorkflowServices,
  createFollowUpWorkflows,
  type FollowUpTiming,
} from './case-workflows.js';
import { createPersistentPlaybookLibrary } from './playbook-library.js';
import { createProcurementEffects } from './procurement-effects.js';
import {
  createPurchasingSystem,
  createSubmissionAdmission,
  createSubmissionEffects,
} from './procurement-submissions.js';
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

/** Correlates supplier-message model calls with the request that made them. */
function supplierTrace(requestId: string) {
  return {
    requestId,
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
}

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
  caseWorkflows: ReturnType<typeof createCaseWorkflowServices>;
  codeProcesses: ReturnType<typeof createCodeProcesses>;
  procurement: ReturnType<typeof createProcurement>;
  commitments: SupplierCommitments;
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
    commitments: SupplierCommitments;
    playbooks: ReturnType<typeof createPersistentPlaybookLibrary>;
    activity: ReturnType<typeof createWorkspaceActivity>;
    measurements: ReturnType<typeof createResolutionMeasurements>;
    learning: ReturnType<typeof createResolutionLearning>;
    operations: ReturnType<typeof createOperationsOverview>;
    metrics: ReturnType<typeof createOperationalMetrics>;
    operationalSummary: ReturnType<typeof createOperationalSummary>;
    records: ReturnType<typeof createRecordExplorer>;
    inventory: ReturnType<typeof createInventoryWorkspace>;
    products: ReturnType<typeof createProductWorkspace>;
    procurementContext: ReturnType<typeof createProcurementContext>;
    fulfillment: ReturnType<typeof createFulfillmentWorkspace>;
    returns: ReturnType<typeof createReturnWorkspace>;
    customers: ReturnType<typeof createCustomerWorkspace>;
    orders: ReturnType<typeof createOrderWorkspace>;
    sourceAuthority: ReturnType<typeof createSourceAuthority>;
    decisions: ReturnType<typeof createDecisionQueue>;
    decisionAssignments: ReturnType<typeof createDecisionAssignments>;
    insights: ReturnType<typeof createInsights>;
    assistant: ReturnType<typeof createWorkspaceAssistant>;
  };
}

export interface ApplicationOptions {
  database: TenantDatabase;
  /** Registered connection categories used for workspace source authority. */
  providerCatalog?: ProviderCatalog;
  identity: IdentityService;
  execution: ExecutionConfiguration;
  replenishmentTransport?: ReplenishmentTransport;
  verifier?: VerificationEvaluator;
  desk?: Parameters<typeof createDeskServices>[3];
  /** Generates workflow drafts from descriptions. Without it, describing workflows is unavailable. */
  modelGateway?: ModelGateway;
  /** Whether the gateway has an EU zero-retention route for authoring, and why not. */
  authoring?: { available: boolean; reason: string | null };
  /** Installed-app decision sources, such as `registry.decisionSources()`, for Needs you. */
  decisionSources?: Parameters<typeof appDecisionProvider>[0][];
  /** Installed-app case workflows, such as `registry.workflowSources()`. */
  workflowSources?: CaseWorkflowAdapter[];
  /**
   * Rereads a stock position's stale sources through installed capabilities, so owners act on
   * current stock. See `createStockRefreshService`.
   */
  refreshStock?: (context: TenantContext, positionId: string) => Promise<void>;
  /** How long the follow-up workflows wait; the simulator demo shortens them. */
  followUps?: FollowUpTiming;
  /** Installed purchasing-system connections. Without them, orders cannot be sent from Luma. */
  purchasing?: {
    runtime: InstalledPurchaseOrderRuntime;
    installations: Pick<ConnectionManagement, 'list'>;
  };
  /** Whether the gateway has an EU zero-retention route for reading supplier messages. */
  supplierExtraction?: { available: boolean; reason: string | null };
  /** Days supplier message text is kept; defaults to 365. */
  supplierMessageRetentionDays?: number;
  /** Whether the gateway has an EU zero-retention route for the workspace assistant. */
  assistant?: { available: boolean; reason: string | null };
  /** Records assistant and tool spans. Without it, the assistant runs untraced. */
  observability?: Observability;
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
  const authority = (scoped: TenantDatabase) =>
    createSourceAuthority(
      scoped,
      (provider) => options.providerCatalog?.get(provider)?.category ?? null,
      identity.refreshContext,
    );
  const detection = createDetectionServices(
    database,
    undefined,
    options.verifier,
    {},
    authority(database),
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
  // Sending purchase orders is an external effect, so it needs enabled execution.
  const submissionEffects =
    options.execution.kind === 'enabled' && options.purchasing
      ? createSubmissionEffects(options.purchasing.runtime, () => commitments)
      : { resolve: async () => null };
  const combinedEffects: EffectRegistry = {
    resolve: async (context, intent) =>
      (await procurementEffects.resolve(context, intent)) ??
      (await submissionEffects.resolve(context, intent)) ??
      effects.resolve(context, intent),
  };
  const resolutionEligible = createAdmissionEligibility(detection.diagnoses);
  const safety = createSafetyServices(database, identity, combinedEffects, {
    eligible: (context, step) =>
      step.subject?.kind === 'purchase_order_submission'
        ? commitments.eligible(context, step)
        : step.subject
          ? replenishment.eligible(context, step)
          : resolutionEligible(context, step),
  });
  const commitments: SupplierCommitments = createSupplierCommitmentService(
    database,
    createAuditLog,
    {
      purchasing: options.purchasing
        ? createPurchasingSystem(
            options.purchasing.runtime,
            options.purchasing.installations,
          )
        : null,
      admission:
        options.execution.kind === 'enabled' && options.purchasing
          ? createSubmissionAdmission(safety, combinedEffects)
          : null,
      refreshContext: identity.refreshContext,
      principal: identity.resolveWorkflowContext,
      openOrder: async (context, order, commandId, reason) => {
        await procurement.transition(context, order.id, {
          id: commandId,
          expectedRevision: order.revision,
          status: 'open',
          reason,
        });
      },
      model: {
        gateway: options.modelGateway ?? null,
        available: options.supplierExtraction?.available ?? false,
        reason:
          options.supplierExtraction?.reason ??
          'Reading supplier messages isn’t set up on this server.',
      },
      trace: (context) => supplierTrace(context.requestId),
      ...(options.supplierMessageRetentionDays
        ? { retentionDays: options.supplierMessageRetentionDays }
        : {}),
    },
  );
  const desk = createDeskServices(
    database,
    identity,
    combinedEffects,
    options.desk,
  );
  const library = createPersistentPlaybookLibrary(
    database,
    identity,
    safety.policies,
  );

  const replenishment = createReplenishmentRuntime({
    db: database,
    identity,
    procurement,
    safety,
    enabled: options.execution.kind === 'enabled',
    ...(options.replenishmentTransport
      ? { transport: options.replenishmentTransport }
      : {}),
    ...(options.refreshStock ? { refreshStock: options.refreshStock } : {}),
  });
  const codeProcesses = createCodeProcesses(
    database,
    identity,
    options.replenishmentTransport,
  );
  const caseWorkflows = createCaseWorkflowServices({
    database,
    identity,
    exceptions: detection.exceptions,
    policies: safety.policies,
    sources: [
      ...(options.workflowSources ?? []),
      // Orders and returns are composed below; follow-ups read them only once runs start.
      ...createFollowUpWorkflows({
        commitments,
        suppliers: async (context) =>
          (await procurement.suppliers(context)).items,
        returns: () => returns,
        orders: () => orders,
        ...(options.followUps ? { timing: options.followUps } : {}),
      }),
    ],
    ...(options.replenishmentTransport
      ? { transport: options.replenishmentTransport }
      : {}),
    enabled: options.execution.kind === 'enabled',
  });

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
    ...caseWorkflows.templates,
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
      ...caseWorkflows.templates.map((item) => item.id),
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
    safety.policies,
    replenishment.api,
    codeProcesses,
    drafts.blockers,
    caseWorkflows,
    createWorkspacePeople(database),
  );
  const decisions = createDecisionQueue(database, {
    cases: caseDecisionQuery,
    providers: [
      replenishmentDecisionProvider(replenishment.pending),
      supplierCommitmentDecisionProvider(async (context) =>
        (await commitments.pending(context)).map((item) => ({
          key: item.attention.key,
          kind: item.attention.kind,
          purchaseOrderId: item.order.id,
          reference: item.order.reference,
          supplierName: item.supplierName,
          summary: item.attention.summary,
          dueAt: item.attention.dueAt,
          expiresAt:
            item.attention.kind === 'submission_approval'
              ? (item.submission?.expiresAt ?? null)
              : null,
          requesterId: item.submission?.requestedBy ?? null,
          canRespond: item.canRespond,
          requestedDeliveryDate: item.submission?.requestedDeliveryDate ?? null,
          // Descriptions read better than canonical SKU keys in a decision.
          lines: item.order.lines.map((l) => ({
            sku: l.description,
            quantity: l.quantity,
            unit: l.unit,
          })),
          line: item.line
            ? {
                sku: item.line.description,
                quantity: item.line.quantity,
                unit: item.line.unit,
              }
            : null,
          commitment: item.commitment
            ? {
                kind: item.commitment.kind,
                quantity: item.commitment.quantity,
                date: item.commitment.date,
                text: item.commitment.text,
                reasons: item.commitment.reviewReasons,
              }
            : null,
        })),
      ),
      workflowHandoverDecisionProvider(async (context) =>
        (await caseWorkflows.handovers(context)).map((item) => ({
          definitionId: item.definitionId,
          name: item.name,
          runId: item.runId,
          handedOverAt: item.handedOverAt,
          title: item.signal.title,
          detail: item.signal.detail,
          domain: item.signal.domain,
          record: item.signal.record,
        })),
      ),
      ...(options.decisionSources ?? []).map(appDecisionProvider),
    ],
    refreshContext: identity.refreshContext,
  });
  const decisionAssignments = createDecisionAssignments(database, {
    refreshContext: identity.refreshContext,
    members: async (context) =>
      (await identity.listMembers(context)).map((member) => member.userId),
    pending: async (context, id) => !!(await decisions.find(context, id)),
  });
  const orderQueries = {
    state: orderStateQueries,
    attention: orderAttentionQuery,
    attentionFor: orderAttentionForOrders,
  };
  const orders = createOrderWorkspace(
    database,
    orderQueries,
    createActivityStore,
    identity.refreshContext,
    authority,
  );
  const fulfillment = createFulfillmentWorkspace(
    database,
    orderQueries,
    createActivityStore,
    identity.refreshContext,
  );
  const inventory = createInventoryWorkspace(database);
  const returns = createReturnWorkspace(database);
  const assistant = createWorkspaceAssistant({
    gateway: options.modelGateway ?? null,
    availability: options.assistant ?? {
      available: false,
      reason: 'Asking Luma isn’t set up on this server.',
    },
    reads: {
      orders,
      issues: detection.cases,
      inventory,
      fulfillment,
      returns,
    },
    refreshContext: identity.refreshContext,
    observability: options.observability,
  });

  return {
    codeProcesses,
    replenishment,
    caseWorkflows,
    workflows,
    drafts,
    draftTests,
    generation,
    templates,
    procurement,
    commitments,
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
      commitments,
      shadow: createShadowEvaluations(database, identity.refreshContext),
      cases: detection.cases,
      desk,
      playbooks: library,
      activity: createWorkspaceActivity(database, identity.refreshContext),
      measurements: createResolutionMeasurements(
        database,
        identity.refreshContext,
      ),
      learning: createResolutionLearning(database, identity.refreshContext),
      operationalSummary: createOperationalSummary(database, {
        cases: createCaseMetricReader,
        resolution: createResolutionMetricReader,
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
        () => new Date(),
        createResolutionMetricReader(database),
      ),
      inventory,
      products: createProductWorkspace(database),
      procurementContext: createProcurementContext(database),
      returns,
      customers: createCustomerWorkspace(database),
      records: createRecordExplorer(database),
      orders,
      sourceAuthority: authority(database),
      fulfillment,
      decisions,
      decisionAssignments,
      insights: createInsights(database, {
        orders: orderQueries,
        cases: caseTimelineQuery,
        stock: createStockRiskReader,
        procurement: async (context) => {
          const [summaries, { items }] = await Promise.all([
            commitments.summaries(context),
            procurement.orders(context),
          ]);
          const orders = new Map(items.map((order) => [order.id, order]));

          // Orders created between the two reads are left for the next refresh.
          return summaries.flatMap((summary) => {
            const order = orders.get(summary.id);

            return order
              ? [
                  {
                    id: summary.id,
                    reference: order.reference,
                    supplierName: order.supplierName,
                    stage: summary.stage,
                    expectedDate: summary.expectedDate,
                    overdue: summary.overdue,
                    attention: summary.attention,
                    nextOwner: summary.nextOwner,
                    createdAt: order.createdAt,
                  },
                ]
              : [];
          });
        },
        refreshContext: identity.refreshContext,
      }),
      assistant,
    },
  };
}
