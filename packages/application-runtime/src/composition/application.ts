import { randomBytes } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import { createWorkspaceAssistant } from '@luma/assistant/composition';
import { createAuditLog } from '@luma/audit/composition';
import type {
  CapabilityReader,
  ConnectionManagement,
  EffectRegistry,
  ProviderCatalog,
} from '@luma/connections';
import {
  createConnectionCoverage,
  createOrderSourceVisibility,
  createPlaybookGrantReader,
  createSourceAuthority,
  type InstalledMessageRuntime,
  type InstalledPurchaseOrderRuntime,
  type InstalledReturnRuntime,
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
import { createMessaging } from '@luma/messaging/composition';
import {
  createOrderMetricReader,
  createReturnActionService,
  createReturnCaseService,
  createReturnDeadlineService,
  createReturnExchangeService,
  orderStateQueries,
  type ReturnActions,
  type ReturnCases,
  type ReturnDeadlines,
  type ReturnExchanges,
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
  createSourceOrderLines,
  messageReplyDecisionProvider,
  replenishmentDecisionProvider,
  replySendDecisionProvider,
  returnCaseDecisionProvider,
  supplierCommitmentDecisionProvider,
  workflowHandoverDecisionProvider,
} from '@luma/read-models/composition';
import {
  createReturnStepFollowUp,
  createShippingMethodTemplate,
  returnStepFollowUpSource,
  shippingMethodPlaybook,
  shippingMethodVocabulary,
} from '@luma/resolution';
import {
  createActivityStore,
  createDecisionAssignments,
  createOperationsOverview,
  createRefundFollowUpCursor,
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
  compileProcessWorkflow,
  createCodeProcesses,
  createCoordination,
  createDraftGenerations,
  createDrafts,
  createDraftTestRuns,
  createWorkflowEventSink,
  createWorkflows,
  createWorkflowTemplates,
} from '@luma/workflows/composition';

import { createAdmissionEligibility } from './admission.js';
import {
  createCaseWorkflowServices,
  createFollowUpWorkflows,
  type FollowUpTiming,
} from './case-workflows.js';
import { createInventoryLedgerRuntime } from './inventory-ledger.js';
import {
  createMailboxConnections,
  createMemberDirectory,
  createMessageReader,
  createProcurementHandoff,
  createRecordDirectory,
} from './messaging.js';
import {
  createAttachmentReader,
  createDocumentDirectory,
} from './messaging-documents.js';
import {
  createRecordStates,
  createReplyAdmission,
  createReplyEffects,
} from './messaging-replies.js';
import { createNativeStockRuntime } from './native-stock.js';
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
  createReturnCreationAdmission,
  createReturnCreationEffects,
  createReturnSystem,
} from './return-cases.js';
import { createReturnConsistencySystem } from './return-consistency.js';
import {
  createReturnExchangeAdmission,
  createReturnExchangeEffects,
} from './return-exchanges.js';
import {
  createReturnSettlementAdmission,
  createReturnSettlementEffects,
  createReturnSettlementSystem,
} from './return-settlement.js';
import { createSalesRuntime } from './sales.js';
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

type ExecutionConfiguration =
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
  coordination: ReturnType<typeof createCoordination>;
  procurement: ReturnType<typeof createProcurement>;
  commitments: SupplierCommitments;
  returnCases: ReturnCases;
  returnActions: ReturnActions;
  returnExchanges: ReturnExchanges;
  returnDeadlines: ReturnDeadlines;
  library: ReturnType<typeof createPersistentPlaybookLibrary>;
  messaging: ReturnType<typeof createMessaging>;
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
    messaging: ReturnType<typeof createMessaging>['service'];
    messagingReplies: ReturnType<typeof createMessaging>['replies'];
    messagingDocuments: ReturnType<typeof createMessaging>['documents'];
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
    returnCases: ReturnCases;
    returnActions: ReturnActions;
    returnExchanges: ReturnExchanges;
    returnDeadlines: ReturnDeadlines;
    customers: ReturnType<typeof createCustomerWorkspace>;
    orders: ReturnType<typeof createOrderWorkspace>;
    sales: ReturnType<typeof createSalesRuntime>;
    inventoryLedger: ReturnType<typeof createInventoryLedgerRuntime>;
    nativeStock: ReturnType<typeof createNativeStockRuntime>;
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
  /**
   * The permission a person needs to request a provider write through an app, such as
   * `registry.actionPermission`. Without it, order change plans name no permission.
   */
  actionPermission?: (appId: string, capability: string) => string | null;
  /** Installed-app case workflows, such as `registry.workflowSources()`. */
  workflowSources?: CaseWorkflowAdapter[];
  /**
   * Rereads a stock position's stale sources through installed capabilities, so owners act on
   * current stock. See `createStockRefreshService`.
   */
  nativeStockReader?: CapabilityReader;
  refreshStock?: (context: TenantContext, positionId: string) => Promise<void>;
  /** How long the follow-up workflows wait; the simulator demo shortens them. */
  followUps?: FollowUpTiming;
  /** Installed purchasing-system connections. Without them, orders cannot be sent from Luma. */
  purchasing?: {
    runtime: InstalledPurchaseOrderRuntime;
    installations: Pick<ConnectionManagement, 'list'>;
  };
  /** Installed connections returns can be created in. Without them, cases still work locally. */
  returns?: {
    runtime: InstalledReturnRuntime;
    installations: Pick<ConnectionManagement, 'list'>;
  };
  /** Whether the gateway has an EU zero-retention route for reading supplier messages. */
  supplierExtraction?: { available: boolean; reason: string | null };
  /** Days supplier message text is kept; defaults to 365. */
  supplierMessageRetentionDays?: number;
  /** Whether the gateway has an EU zero-retention route for the workspace assistant. */
  assistant?: { available: boolean; reason: string | null };
  /** Whether the gateway has an EU zero-retention route for reading message attachments. */
  documentExtraction?: { available: boolean; reason: string | null };
  /** Records assistant and tool spans. Without it, the assistant runs untraced. */
  observability?: Observability;
  /**
   * Installed mailboxes. Without `reader`, mailboxes and threads are managed but not read;
   * without `installations`, no mailboxes are listed.
   */
  messaging?: {
    installations?: Pick<ConnectionManagement, 'list'>;
    reader?: CapabilityReader;
    /** Sends replies through installed mailboxes; needs enabled execution. */
    sender?: Pick<InstalledMessageRuntime, 'sendEffects'>;
    /** Days message text and attachment content are kept; defaults to 365. */
    retentionDays?: number;
    /** Time between reads of a current mailbox. */
    pollMs?: number;
    log?: (message: string, error?: unknown) => void;
  };
}

/**
 * Reads another connection's stored line quantities for a source order, so app hosts can let
 * apps propagate an authoritative source's values. See `AppFactoryContext.sourceOrderLines`.
 */
export function createOrderLineReader(
  database: TenantDatabase,
): NonNullable<AppFactoryContext['sourceOrderLines']> {
  return createSourceOrderLines(database, { state: orderStateQueries });
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
  const erpEnabledForTenant = async (tenantId: string) => {
    const observation = options.observability?.request(
      randomBytes(16).toString('hex'),
    );
    if (!observation || !options.observability) return false;
    try {
      const trace = options.observability.forTenant(
        observation.context,
        tenantId,
        'EU',
      );

      return await options.observability.flag(trace, 'luma-erp-orders', false);
    } finally {
      observation.end();
    }
  };
  const hiddenOrderSources = createOrderSourceVisibility(
    database,
    erpEnabledForTenant,
  );
  const authority = (scoped: TenantDatabase) =>
    createSourceAuthority(
      scoped,
      (provider) =>
        provider === 'luma-erp'
          ? 'erp'
          : (options.providerCatalog?.get(provider)?.category ?? null),
      identity.refreshContext,
      erpEnabledForTenant,
    );
  const detection = createDetectionServices(
    database,
    undefined,
    options.verifier,
    {},
    authority(database),
    identity,
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
  // Sending replies is an external effect too; replies are composed below.
  const sender = options.messaging?.sender;
  const replyEffects =
    options.execution.kind === 'enabled' && sender
      ? createReplyEffects(sender, () => messaging.replies)
      : { resolve: async () => null };
  // Creating a return in the order's system is an external effect, so it needs enabled execution.
  const returnCreationEffects =
    options.execution.kind === 'enabled' && options.returns
      ? createReturnCreationEffects(options.returns.runtime, () => returnCases)
      : { resolve: async () => null };
  const settlementEffects =
    options.execution.kind === 'enabled' && options.returns
      ? createReturnSettlementEffects(
          options.returns.runtime,
          () => returnActions,
        )
      : { resolve: async () => null };
  const exchangeEffects =
    options.execution.kind === 'enabled' && options.returns
      ? createReturnExchangeEffects(
          options.returns.runtime,
          () => returnExchanges,
        )
      : { resolve: async () => null };
  const combinedEffects: EffectRegistry = {
    resolve: async (context, intent) =>
      (await procurementEffects.resolve(context, intent)) ??
      (await submissionEffects.resolve(context, intent)) ??
      (await replyEffects.resolve(context, intent)) ??
      (await returnCreationEffects.resolve(context, intent)) ??
      (await settlementEffects.resolve(context, intent)) ??
      (await exchangeEffects.resolve(context, intent)) ??
      effects.resolve(context, intent),
  };
  const resolutionEligible = createAdmissionEligibility(detection.diagnoses);
  const safety = createSafetyServices(database, identity, combinedEffects, {
    eligible: (context, step) =>
      step.subject?.kind === 'purchase_order_submission'
        ? commitments.eligible(context, step)
        : step.subject?.kind === 'message_outbound'
          ? messaging.replies.eligible(context, step)
          : step.subject?.kind === 'return_case_creation'
            ? returnCases.eligible(context, step)
            : step.subject?.kind === 'return_case_settlement'
              ? returnActions.eligible(context, step)
              : step.subject?.kind === 'return_case_exchange'
                ? returnExchanges.eligible(context, step)
                : step.subject
                  ? replenishment.eligible(context, step)
                  : resolutionEligible(context, step),
  });
  const commitments: SupplierCommitments = createSupplierCommitmentService(
    database,
    createAuditLog,
    {
      observed: async (db, observation) => {
        if (observation.confirmed)
          await createWorkflowEventSink(db)(observation.tenantId, {
            sourceId: `supplier-acknowledgment:${observation.id}`,
            eventType: 'supplier.acknowledged',
            correlationKey: observation.purchaseOrderId,
            occurredAt: observation.observedAt,
            values: { acknowledged: true },
            evidenceRefs: [`procurement_observation:${observation.id}`],
          });
      },
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
  const directory = createRecordDirectory(database);
  const messaging = createMessaging(database, {
    audit: createAuditLog,
    refreshContext: identity.refreshContext,
    resolveContext: identity.resolveWorkflowContext,
    connections: createMailboxConnections(
      database,
      options.messaging?.installations ?? { list: async () => [] },
    ),
    directory,
    members: createMemberDirectory(identity),
    reader: options.messaging?.reader
      ? createMessageReader(options.messaging.reader)
      : undefined,
    handoff: createProcurementHandoff(() => commitments),
    // The order workspace is composed below; drafts read it only once requests arrive.
    records: createRecordStates({
      orders: () => orders,
      commitments: () => commitments,
      directory,
    }),
    replyAdmission:
      options.execution.kind === 'enabled' && sender
        ? createReplyAdmission(safety, combinedEffects)
        : null,
    // Attachments are read through the same installed runtime as messages.
    documents: {
      attachments: options.messaging?.reader
        ? createAttachmentReader(options.messaging.reader)
        : undefined,
      directory: createDocumentDirectory(database),
      extraction: {
        gateway: options.modelGateway ?? null,
        available: options.documentExtraction?.available ?? false,
        reason:
          options.documentExtraction?.reason ??
          'Reading documents automatically isn’t set up on this server.',
      },
    },
    retentionDays: options.messaging?.retentionDays,
    pollMs: options.messaging?.pollMs,
    log: options.messaging?.log,
  });
  const returnCases: ReturnCases = createReturnCaseService(
    database,
    createAuditLog,
    {
      system: options.returns
        ? createReturnSystem(
            options.returns.runtime,
            options.returns.installations,
          )
        : null,
      admission:
        options.execution.kind === 'enabled' && options.returns
          ? createReturnCreationAdmission(safety, combinedEffects)
          : null,
      refreshContext: identity.refreshContext,
      principal: identity.resolveWorkflowContext,
    },
  );
  const returnActions = createReturnActionService(database, createAuditLog, {
    system: options.returns
      ? createReturnSettlementSystem(options.returns.runtime)
      : null,
    admission:
      options.execution.kind === 'enabled' && options.returns
        ? createReturnSettlementAdmission(safety, combinedEffects)
        : null,
    refreshContext: identity.refreshContext,
    principal: identity.resolveWorkflowContext,
  });
  const returnExchanges = createReturnExchangeService(
    database,
    createAuditLog,
    {
      system: options.returns
        ? createReturnConsistencySystem(options.returns.runtime)
        : null,
      admission:
        options.execution.kind === 'enabled' && options.returns
          ? createReturnExchangeAdmission(safety, combinedEffects)
          : null,
      refreshContext: identity.refreshContext,
      principal: identity.resolveWorkflowContext,
    },
  );
  const returnDeadlines = createReturnDeadlineService(
    database,
    createAuditLog,
    {
      refreshContext: identity.refreshContext,
      source: {
        async money(context, value, refund, exchange) {
          const step = value.proposal?.kind === 'exchange' ? exchange : refund;
          if (!step?.sent)
            return {
              state: 'not_requested',
              readable: true,
              complete: true,
              observedAt: value.proposal?.at ?? null,
              evidenceRefs: [`case:${value.id}:${value.revision}`],
              requestedAt: step?.requestedAt ?? null,
            };
          if (!options.returns)
            throw new Error('Return financial reads unavailable');
          const proof =
            value.proposal?.kind === 'exchange' && exchange
              ? await returnExchanges.observe(context, value.id, exchange.id)
              : refund
                ? await returnActions.observe(context, value.id, refund.id)
                : null;

          return {
            state: proof?.payment ?? 'unknown',
            readable: true,
            complete:
              !!proof &&
              proof.payment !== null &&
              proof.payment !== 'unknown' &&
              proof.evidenceRefs.length > 0,
            observedAt: proof?.observedAt ?? null,
            evidenceRefs: proof?.evidenceRefs ?? [],
            requestedAt: step.requestedAt,
          };
        },
      },
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
  const coordination = createCoordination(database, identity, createAuditLog);
  const codeProcesses = createCodeProcesses(
    database,
    identity,
    options.replenishmentTransport,
  );
  const caseWorkflows = createCaseWorkflowServices({
    database,
    identity,
    exceptions: detection.exceptions,
    cases: detection.cases,
    policies: safety.policies,
    sources: [
      ...(options.workflowSources ?? []),
      createReturnStepFollowUp({
        version: compileProcessWorkflow(returnStepFollowUpSource),
        configured: async (context) =>
          (await returnDeadlines.policy(context)).policy?.enabled === true,
        tick: (context) => returnDeadlines.tick(context),
        pending: (context) => returnDeadlines.pending(context),
        get: (context, id) => returnDeadlines.occurrence(context, id),
      }),
      // Orders and returns are composed below; follow-ups read them only once runs start.
      ...createFollowUpWorkflows({
        refundCursor: createRefundFollowUpCursor(database),
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
    coordination,
  );
  const decisions = createDecisionQueue(database, {
    cases: caseDecisionQuery,
    providers: [
      {
        id: 'human-tasks',
        label: 'Human tasks',
        permission: 'workflows.read',
        pending: async (context) =>
          (await coordination.pending(context)).map((task) => ({
            id: `human-task:${task.runId}:${task.stepId}`,
            kind: 'human_task' as const,
            reason: 'manual_intervention' as const,
            domain: 'operations' as const,
            title: task.instructions,
            why: task.escalatedAt
              ? 'The task is overdue and has been assigned to its fallback.'
              : 'A workflow needs your answer and evidence to continue.',
            consequences: [
              {
                response: 'Answer',
                text: 'Record your answer and resume the workflow. Provider changes still require policy admission.',
              },
            ],
            change: [{ label: 'Evidence', value: task.evidence }],
            impact: { level: 'unknown' as const, text: null },
            requestedAt: task.createdAt,
            deadline: task.dueAt,
            requesterId: null,
            evidence: { observedAt: null, validUntil: null },
            response: 'investigate' as const,
            ownerAssignment: {
              assigneeId: context.actor.id,
              assignedBy: context.actor.id,
              assignedAt: task.createdAt,
              revision: 0,
            },
            subject: { label: task.subject.kind, detail: task.subject.id },
            // An order task links to the order, where its change plan shows what to do.
            record:
              task.subject.kind === 'order'
                ? { kind: 'order' as const, id: task.subject.id }
                : null,
            owner: {
              kind: 'human_task' as const,
              definitionId: task.definitionId,
              runId: task.runId,
              stepId: task.stepId,
            },
            group: {
              key: `human-task:${task.definitionId}`,
              label: task.definitionId,
            },
          })),
      },
      replenishmentDecisionProvider(replenishment.pending),
      returnCaseDecisionProvider(async (context) => {
        const [cases, waits] = await Promise.all([
          returnCases.pending(context),
          returnDeadlines.pending(context),
        ]);

        return cases.map((value) => {
          const waiting = waits.find((w) => w.caseId === value.case.id);

          return waiting ? { ...value, waiting } : value;
        });
      }),
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
          observeOnly: item.submission?.observeOnly ?? false,
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
      messageReplyDecisionProvider(async (context) =>
        (await messaging.service.dueReplies(context)).map((item) => ({
          threadId: item.threadId,
          subject: item.subject,
          correspondent: item.correspondent?.name
            ? `${item.correspondent.name} <${item.correspondent.address}>`
            : (item.correspondent?.address ?? null),
          mailboxLabel: item.mailboxLabel,
          replyDueAt: item.replyDueAt,
          receivedAt: item.lastInboundAt ?? item.lastMessageAt,
          canRespond: item.canRespond,
        })),
      ),
      replySendDecisionProvider((context) =>
        messaging.replies.pending(context),
      ),
      ...(options.decisionSources ?? []).map(appDecisionProvider),
    ],
    refreshContext: identity.refreshContext,
  });
  const decisionAssignments = createDecisionAssignments(database, {
    refreshContext: identity.refreshContext,
    members: async (context) =>
      (await identity.listMembers(context)).map((member) => member.userId),
    pending: async (context, id) => {
      const item = await decisions.find(context, id);

      // Return case assignments belong to the case's revision-checked command.
      return !!item && item.owner.kind !== 'return_case';
    },
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
    undefined,
    hiddenOrderSources,
    options.actionPermission,
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
    coordination,
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
    returnCases,
    returnActions,
    returnExchanges,
    returnDeadlines,
    detection,
    safety,
    desk,
    playbooks,
    library,
    messaging,
    http: {
      messaging: messaging.service,
      messagingReplies: messaging.replies,
      messagingDocuments: messaging.documents,
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
        orders: (db) =>
          createOrderMetricReader(db, orderAttentionQuery, hiddenOrderSources),
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
      returnCases,
      returnActions,
      returnExchanges,
      returnDeadlines,
      customers: createCustomerWorkspace(database),
      records: createRecordExplorer(database, hiddenOrderSources),
      orders,
      inventoryLedger: createInventoryLedgerRuntime(database, identity),
      nativeStock: createNativeStockRuntime(
        database,
        identity,
        (context) => erpEnabledForTenant(context.tenantId),
        authority,
        options.nativeStockReader,
      ),
      sales: createSalesRuntime(
        database,
        identity,
        (context) => erpEnabledForTenant(context.tenantId),
        authority,
      ),
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
