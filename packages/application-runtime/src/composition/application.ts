import { createHash, randomBytes } from 'node:crypto';

import { isFieldWriteCapability } from '@luma/adaptive';
import {
  createAdaptiveFieldEffects,
  createAdaptiveFields,
  createAdaptiveFieldWorkflows,
} from '@luma/adaptive/composition';
import type { AppFactoryContext, AppRegistry } from '@luma/app-host';
import { createWorkspaceAssistant } from '@luma/assistant/composition';
import { createAuditLog } from '@luma/audit/composition';
import type {
  CapabilityReader,
  ConnectionManagement,
  EffectRegistry,
  ProviderCatalog,
} from '@luma/connections';
import { describeActionDiff } from '@luma/connections';
import {
  createConnectionCoverage,
  createOrderSourceVisibility,
  createSourceAuthority,
  type InstalledMessageRuntime,
  type InstalledPurchaseOrderRuntime,
  type InstalledReturnRuntime,
} from '@luma/connections/composition';
import { createCustomerErasure } from '@luma/customers/composition';
import type { VerificationEvaluator } from '@luma/exceptions';
import { createPendingStockSyncReader } from '@luma/exceptions/composition';
import type { BoundActionStep } from '@luma/execution';
import type { IdentityService, TenantContext } from '@luma/identity';
import {
  createPurchaseIncoming,
  createPurchaseIncomingStore,
  createPurchaseReceiptStages,
} from '@luma/inventory/composition';
import { createMessaging } from '@luma/messaging/composition';
import {
  createReturnActionService,
  createReturnCaseService,
  createReturnDeadlineService,
  createReturnExchangeService,
  createReturnMoneySource,
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
import { canonicalJson } from '@luma/platform';
import { createFollowUpEnvironmentReader } from '@luma/procurement';
import {
  createIncomingStock,
  createIncomingStockReader,
  createProcurement,
  createPurchaseOrderChanges,
  createPurchasing,
  createPurchasingInputs,
  createPurchasingOutcomePersistence,
  createPurchasingOutcomesService,
  createPurchasingOverview,
  createPurchasingStore,
  createPurchasingTimelineActors,
  createReplenishmentReviewContext,
  createShortfallAcknowledgement,
  createSupplierCommitmentService,
  createSupplierEmailService,
  createSupplierTerms,
  type SupplierCommitments,
} from '@luma/procurement/composition';
import {
  appDecisionProvider,
  createActionDiffReader,
  createSourceOrderLines,
  readNativePurchaseIncoming,
} from '@luma/read-models/composition';
import {
  createReturnStepFollowUp,
  returnStepFollowUpSource,
} from '@luma/resolution';
import {
  createOperationsOverview,
  createRefundFollowUpCursor,
  createResolutionLearning,
  createResolutionMeasurements,
  createResolutionMetricReader,
  createShadowEvaluations,
  createWorkspaceActivity,
  createWorkspacePeople,
} from '@luma/resolution/composition';
import type {
  CaseWorkflowAdapter,
  WorkflowImprovementControls,
} from '@luma/workflows';
import {
  compileProcessWorkflow,
  createCodeProcesses,
  createCoordination,
  createProcessStepStore,
  createWorkflowEventSink,
  createWorkflows,
  createWorkflowTriggerStore,
} from '@luma/workflows/composition';

import { createActiveDiagnosisRereader } from './active-diagnosis.js';
import { createAdaptiveWorkspaceRuntime } from './adaptive.js';
import {
  createAdmissionEligibility,
  routeAdmissionEligibility,
} from './admission.js';
import {
  createCaseWorkflowServices,
  createFollowUpWorkflows,
  type FollowUpTiming,
} from './case-workflows.js';
import { createDecisionServices } from './decisions.js';
import { createTenantFeatureRelease } from './feature-release.js';
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
  createPurchaseOrderChangeAdmission,
  createPurchaseOrderChangeEffects,
} from './purchase-order-changes.js';
import { createPurchaseReceiptTimeline } from './purchase-receipt-timeline.js';
import { createPurchasingAdmission } from './purchasing-admission.js';
import {
  createReadModelServices,
  type ReadModelServices,
} from './read-models.js';
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
import { createScopedSupplierFollowUp } from './scoped-follow-up.js';
import {
  createDeskServices,
  createDetectionServices,
  createResolutionPlaybooks,
  createSafetyServices,
} from './services.js';
import {
  createWorkflowAuthoring,
  type WorkflowAuthoring,
} from './workflow-authoring.js';

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
  drafts: WorkflowAuthoring['drafts'];
  draftTests: WorkflowAuthoring['draftTests'];
  generation: WorkflowAuthoring['generation'];
  templates: WorkflowAuthoring['templates'];
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
    activity: ReturnType<typeof createWorkspaceActivity>;
    adaptive: ReturnType<typeof createAdaptiveWorkspaceRuntime>;
    assistant: ReturnType<typeof createWorkspaceAssistant>;
    cases: ReturnType<typeof createDetectionServices>['cases'];
    changes: ReadModelServices['changes'];
    commitments: SupplierCommitments;
    connectionCoverage: import('@luma/connections').CoverageReader;
    customerErasure: ReturnType<typeof createCustomerErasure>;
    customers: ReadModelServices['customers'];
    decisionAssignments: ReturnType<
      typeof createDecisionServices
    >['assignments'];
    decisions: ReturnType<typeof createDecisionServices>['decisions'];
    desk: ReturnType<typeof createDeskServices>;
    draftTests: WorkflowAuthoring['draftTests'];
    evidence: ReadModelServices['evidence'];
    fieldWorkflows: ReturnType<typeof createAdaptiveFieldWorkflows>;
    fulfillment: ReadModelServices['fulfillment'];
    governedFollowUps: ReturnType<
      typeof createScopedSupplierFollowUp
    >['service'];
    incoming: ReturnType<typeof createIncomingStock>;
    insights: ReadModelServices['insights'];
    inventory: ReadModelServices['inventory'];
    inventoryLedger: ReturnType<typeof createInventoryLedgerRuntime>;
    learning: ReturnType<typeof createResolutionLearning>;
    measurements: ReturnType<typeof createResolutionMeasurements>;
    messaging: ReturnType<typeof createMessaging>['service'];
    messagingDocuments: ReturnType<typeof createMessaging>['documents'];
    messagingReplies: ReturnType<typeof createMessaging>['replies'];
    metrics: ReadModelServices['metrics'];
    nativeStock: ReturnType<typeof createNativeStockRuntime>;
    operationalSummary: ReadModelServices['operationalSummary'];
    operations: ReturnType<typeof createOperationsOverview>;
    orderChanges: ReturnType<typeof createPurchaseOrderChanges>;
    orders: ReadModelServices['orders'];
    playbooks: ReturnType<typeof createPersistentPlaybookLibrary>;
    procurement: ReturnType<typeof createProcurement>;
    procurementContext: ReadModelServices['procurementContext'];
    products: ReadModelServices['products'];
    purchasing: ReturnType<typeof createPurchasing>;
    purchasingOutcomes: ReturnType<typeof createPurchasingOutcomesService>;
    records: ReadModelServices['records'];
    returnActions: ReturnActions;
    returnCases: ReturnCases;
    returnDeadlines: ReturnDeadlines;
    returnExchanges: ReturnExchanges;
    returns: ReadModelServices['returns'];
    sales: ReturnType<typeof createSalesRuntime>;
    scopedAutonomy: ReturnType<typeof createSafetyServices>['autonomy'];
    shadow: ReturnType<typeof createShadowEvaluations>;
    sourceAuthority: ReturnType<typeof createSourceAuthority>;
    supplierEmail: ReturnType<typeof createSupplierEmailService>;
    supplierTerms: ReturnType<typeof createSupplierTerms>;
    workflowDrafts: WorkflowAuthoring['drafts'];
    workflowGeneration: WorkflowAuthoring['generation'];
    workflowTemplates: WorkflowAuthoring['templates'];
    workflows: ReturnType<typeof createWorkflows>;
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
  /** Whether the gateway has a regional zero-retention route for authoring, and why not. */
  authoring?: { available: boolean; reason: string | null };
  /** Trusted isolated admission and committed recovery evaluation; absent means unavailable. */
  workflowImprovementControls?: WorkflowImprovementControls;
  /** Installed-app decision sources, such as `registry.decisionSources()`, for Needs you. */
  decisionSources?: Parameters<typeof appDecisionProvider>[0][];
  /** Apps' readers of the evidence they store, such as `registry.evidenceSources()`. */
  evidenceSources?: ReturnType<AppRegistry['evidenceSources']>;
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
  /** Positive transport-manifest proof only; absence is never interpreted as live. */
  connectionEnvironment?(
    context: TenantContext,
    connectionId: string,
  ): Promise<import('@luma/connections').SourceEnvironmentProof>;
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
  /** Whether the gateway has a regional zero-retention route for reading supplier messages. */
  supplierExtraction?: { available: boolean; reason: string | null };
  /** Days supplier message text is kept; defaults to 365. */
  supplierMessageRetentionDays?: number;
  /** Whether the gateway has a regional zero-retention route for the workspace assistant. */
  assistant?: { available: boolean; reason: string | null };
  /** Whether the gateway has a regional zero-retention route for reading message attachments. */
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

/** Kinds of action a runtime's effect registry can resolve, grouped by the owner that binds them. */
export type EffectFamily =
  | 'adaptive_fields'
  | 'procurement'
  | 'supplier_follow_up'
  | 'purchase_order_submission'
  | 'purchase_order_change'
  | 'reply'
  | 'return_creation'
  | 'return_settlement'
  | 'return_exchange';

/**
 * Lists the effect families a runtime composed with these options can resolve. Disabled execution
 * resolves none. Purchase orders, replies and returns also need their installed provider runtime;
 * every runtime that has one resolves the same adapter, so an attempt reserved in one process can
 * be reconciled in another.
 */
export function resolvableEffects(
  options: Pick<
    ApplicationOptions,
    'execution' | 'purchasing' | 'returns' | 'messaging'
  >,
): ReadonlySet<EffectFamily> {
  if (options.execution.kind !== 'enabled') return new Set();
  const families: EffectFamily[] = [
    'adaptive_fields',
    'procurement',
    'supplier_follow_up',
  ];
  if (options.purchasing)
    families.push('purchase_order_submission', 'purchase_order_change');
  if (options.messaging?.sender) families.push('reply');
  if (options.returns)
    families.push('return_creation', 'return_settlement', 'return_exchange');

  return new Set(families);
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
        options.observability.dataRegion ?? 'AU',
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
  const diagnosisRereader = createActiveDiagnosisRereader({
    database,
    authority: authority(database),
    reader: options.nativeStockReader,
    identity,
    enabled: (tenantId) =>
      createTenantFeatureRelease(options.observability)(
        tenantId,
        'active-diagnosis',
      ),
  });
  const detection = createDetectionServices(
    database,
    undefined,
    options.verifier,
    { ...(diagnosisRereader ? { rereader: diagnosisRereader } : {}) },
    authority(database),
    identity,
  );
  const purchasingRelease = createTenantFeatureRelease(options.observability);
  const nativeIncomingHash = (value: unknown) =>
    createHash('sha256').update(canonicalJson(value)).digest('hex');
  const nativeIncoming = createPurchaseIncoming({
    store: createPurchaseIncomingStore(
      database,
      createAuditLog,
      readNativePurchaseIncoming,
    ),
    refreshContext: identity.refreshContext,
    enabled: (context) =>
      purchasingRelease(context.tenantId, 'purchasing-incoming'),
    hash: nativeIncomingHash,
    uuid: (key) => {
      const hex = nativeIncomingHash(key);

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
  });
  const projectIncoming = async (
    context: import('@luma/identity').TenantContext,
    orderId: string,
  ) => {
    await nativeIncoming.reconcile(context, orderId);
  };
  const incoming = createIncomingStock({
    refreshContext: identity.refreshContext,
    enabled: (context) =>
      purchasingRelease(context.tenantId, 'purchasing-incoming'),
    read: createIncomingStockReader(database),
    now: () => new Date(),
  });
  const supplierTerms = createSupplierTerms(
    database,
    identity.refreshContext,
    createAuditLog,
    (context) =>
      purchasingRelease(context.tenantId, 'supplier-purchasing-terms'),
  );
  const procurement = createProcurement(
    database,
    identity.refreshContext,
    createAuditLog,
    projectIncoming,
  );
  // The owners below and their action controls refer to each other. `safety` admits and runs
  // every owner's actions through `combinedEffects` and its `eligible` chain, which call back
  // into owners composed after it; supplier commitments, messaging and supplier email also read
  // one another. These references are closures that run only once requests arrive, so an owner
  // may be named before it is composed. Keep these owners in this function, where that order
  // stays visible; services that only read composed owners have their own modules.
  const resolvable = resolvableEffects(options);
  const none: EffectRegistry = { resolve: async () => null };
  const procurementEffects = resolvable.has('procurement')
    ? createProcurementEffects(procurement)
    : none;
  // Sending purchase orders, replies and returns are external effects; they need enabled
  // execution and the installed provider runtime.
  const submissionEffects =
    resolvable.has('purchase_order_submission') && options.purchasing
      ? createSubmissionEffects(options.purchasing.runtime, () => commitments)
      : none;
  const orderChangeEffects =
    resolvable.has('purchase_order_change') && options.purchasing
      ? createPurchaseOrderChangeEffects(
          options.purchasing.runtime,
          () => orderChanges,
        )
      : none;
  // Replies are composed below.
  const sender = options.messaging?.sender;
  const replyEffects =
    resolvable.has('reply') && sender
      ? createReplyEffects(sender, () => messaging.replies)
      : none;
  const returnCreationEffects =
    resolvable.has('return_creation') && options.returns
      ? createReturnCreationEffects(options.returns.runtime, () => returnCases)
      : none;
  const settlementEffects =
    resolvable.has('return_settlement') && options.returns
      ? createReturnSettlementEffects(
          options.returns.runtime,
          () => returnActions,
        )
      : none;
  const exchangeEffects =
    resolvable.has('return_exchange') && options.returns
      ? createReturnExchangeEffects(
          options.returns.runtime,
          () => returnExchanges,
        )
      : none;
  const adaptiveFieldService = createAdaptiveFields(database, {
    audit: createAuditLog,
    refreshContext: identity.refreshContext,
    released: (context) =>
      purchasingRelease(context.tenantId, 'adaptive-custom-fields'),
  });
  const adaptiveFieldEffects: EffectRegistry = resolvable.has('adaptive_fields')
    ? createAdaptiveFieldEffects(adaptiveFieldService)
    : none;
  let adaptiveFieldEligibility: (
    context: TenantContext,
    step: BoundActionStep,
  ) => Promise<boolean> = async () => false;
  const combinedEffects: EffectRegistry = {
    resolve: async (context, intent) =>
      (await adaptiveFieldEffects.resolve(context, intent)) ??
      (await procurementEffects.resolve(context, intent)) ??
      (await submissionEffects.resolve(context, intent)) ??
      (await orderChangeEffects.resolve(context, intent)) ??
      (await replyEffects.resolve(context, intent)) ??
      (await returnCreationEffects.resolve(context, intent)) ??
      (await settlementEffects.resolve(context, intent)) ??
      (await exchangeEffects.resolve(context, intent)) ??
      (resolvable.has('supplier_follow_up')
        ? await scopedFollowUp?.effects.resolve(context, intent)
        : null) ??
      effects.resolve(context, intent),
  };
  const resolutionEligible = createAdmissionEligibility(detection.diagnoses);
  const safety = createSafetyServices(database, identity, combinedEffects, {
    diffRequired: (tenantId) =>
      purchasingRelease(tenantId, 'action-review-diffs'),
    autonomyEnabled: (tenantId) =>
      purchasingRelease(tenantId, 'scoped-autonomy'),
    ...(options.connectionEnvironment
      ? { environment: options.connectionEnvironment }
      : {}),
    responsibilityFacts: async (context, action) =>
      (await scopedFollowUp?.facts(context, action)) ?? null,
    // Owners are composed below; each route reads its owner only when a step is checked.
    eligible: routeAdmissionEligibility({
      fieldWrite: {
        matches: isFieldWriteCapability,
        eligible: (context, step) => adaptiveFieldEligibility(context, step),
      },
      subjects: {
        purchase_order_change: (context, step) =>
          orderChanges.eligible(context, step),
        purchasing_plan: (context, step) => purchasing.eligible(context, step),
        purchase_order_submission: (context, step) =>
          commitments.eligible(context, step),
        message_outbound: (context, step) =>
          messaging.replies.eligible(context, step),
        return_case_creation: (context, step) =>
          returnCases.eligible(context, step),
        return_case_settlement: (context, step) =>
          returnActions.eligible(context, step),
        return_case_exchange: (context, step) =>
          returnExchanges.eligible(context, step),
        supplier_follow_up: (context, step) =>
          scopedFollowUp?.eligible(context, step) ?? Promise.resolve(false),
      },
      otherSubject: (context, step) => replenishment.eligible(context, step),
      noSubject: resolutionEligible,
    }),
  });
  const purchasing = createPurchasing({
    store: createPurchasingStore(database, createAuditLog),
    overview: createPurchasingOverview({
      terms: supplierTerms,
      procurement,
      inputs: createPurchasingInputs(database, authority(database)),
      incoming: createIncomingStockReader(database),
    }),
    refreshContext: identity.refreshContext,
    principal: (tenantId, actorId, requestId) =>
      identity.resolveWorkflowContext(actorId, tenantId, requestId),
    released: (context, key) => purchasingRelease(context.tenantId, key),
    admission: resolvable.has('procurement')
      ? createPurchasingAdmission(safety, combinedEffects)
      : null,
    shortfall: (context, orderId, key) =>
      commitments.shortfall(context, orderId, key),
    acknowledgeShortfall: createShortfallAcknowledgement(() => commitments),
    now: () => new Date(),
    uuid: (key) => {
      const hex = createHash('sha256')
        .update(`luma:purchasing:${key}`)
        .digest('hex');

      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
  });
  const purchasingOutcomes = createPurchasingOutcomesService({
    ...createPurchasingOutcomePersistence(database, createAuditLog),
    refreshContext: identity.refreshContext,
    overview: (context) => purchasing.overview(context),
    enabled: (context) =>
      purchasingRelease(context.tenantId, 'purchasing-outcomes'),
  });
  const commitments: SupplierCommitments = createSupplierCommitmentService(
    database,
    createAuditLog,
    {
      timelineActors: createPurchasingTimelineActors(database),
      incomingChanged: projectIncoming,
      additionalTimeline: createPurchaseReceiptTimeline(
        () => nativeStock.ledger,
        createPurchaseReceiptStages(database),
      ),
      reconciliationAvailable: (context) =>
        purchasingRelease(context.tenantId, 'purchasing-receipts'),
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
      admission: resolvable.has('purchase_order_submission')
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
        reason: options.supplierExtraction?.reason ?? null,
      },
      trace: (context) => supplierTrace(context.requestId),
      ...(options.supplierMessageRetentionDays
        ? { retentionDays: options.supplierMessageRetentionDays }
        : {}),
    },
  );
  const orderChanges = createPurchaseOrderChanges(database, createAuditLog, {
    commitments,
    changed: projectIncoming,
    purchasing: options.purchasing
      ? createPurchasingSystem(
          options.purchasing.runtime,
          options.purchasing.installations,
        )
      : null,
    admission: resolvable.has('purchase_order_change')
      ? createPurchaseOrderChangeAdmission(safety, combinedEffects)
      : null,
    refreshContext: identity.refreshContext,
    principal: (actorId, tenantId) =>
      identity.resolveWorkflowContext(
        actorId,
        tenantId,
        `purchase-order-change:${actorId}`,
      ),
    released: (context) =>
      purchasingRelease(context.tenantId, 'purchasing-order-changes'),
    canRevise: async (context, connectionId) =>
      !!(await options.purchasing?.installations.list(context))?.find(
        (c) =>
          c.id === connectionId &&
          c.status === 'active' &&
          c.granted.includes('purchase-orders.revise'),
      ),
  });
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
    settled: (context, outbound) => supplierEmail.settled(context, outbound),
    eligibleOwner: (context, outbound) =>
      supplierEmail.eligible(context, outbound),
    // The order workspace is composed below; drafts read it only once requests arrive.
    records: createRecordStates({
      orders: () => orders,
      commitments: () => commitments,
      directory,
    }),
    replyAdmission: resolvable.has('reply')
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
        reason: options.documentExtraction?.reason ?? null,
      },
    },
    retentionDays: options.messaging?.retentionDays,
    pollMs: options.messaging?.pollMs,
    log: options.messaging?.log,
  });
  const supplierEmail = createSupplierEmailService({
    commitments,
    refreshContext: identity.refreshContext,
    available: (context, feature) =>
      purchasingRelease(
        context.tenantId,
        feature === 'submission'
          ? 'procurement-email-submission'
          : 'procurement-supplier-follow-ups',
      ),
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    now: () => new Date(),
    inbox: {
      mailboxes: (context) => messaging.service.mailboxes(context),
      work: (context, id) => messaging.replies.supplierWork(context, id),
      attachment: (context, orderId, outboundId) =>
        messaging.replies.supplierAttachment(context, orderId, outboundId),
      compose: (context, input) => messaging.replies.compose(context, input),
      threads: async (context, id) =>
        (
          await messaging.service.recordThreads(context, 'purchase_order', id)
        ).items.map((t) => ({
          id: t.id,
          connectionId: t.connectionId,
          address: t.correspondent?.address ?? null,
        })),
    },
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
      admission: resolvable.has('return_creation')
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
    admission: resolvable.has('return_settlement')
      ? createReturnSettlementAdmission(safety, combinedEffects)
      : null,
    describeDiff: async (context, action, observedAt, plan) =>
      (await purchasingRelease(context.tenantId, 'action-review-diffs'))
        ? describeActionDiff(action, observedAt, { plan })
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
      admission: resolvable.has('return_exchange')
        ? createReturnExchangeAdmission(safety, combinedEffects)
        : null,
      describeDiff: async (context, action, observedAt, plan) =>
        (await purchasingRelease(context.tenantId, 'action-review-diffs'))
          ? describeActionDiff(action, observedAt, { plan })
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
      // Without installed return connections, sent money cannot be read.
      source: createReturnMoneySource(
        options.returns
          ? {
              refund: (context, caseId, id) =>
                returnActions.observe(context, caseId, id),
              exchange: (context, caseId, id) =>
                returnExchanges.observe(context, caseId, id),
            }
          : null,
      ),
    },
  );
  const desk = createDeskServices(database, identity, combinedEffects, {
    ...options.desk,
    diffEnabled: (tenantId) =>
      purchasingRelease(tenantId, 'action-review-diffs'),
  });
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
    reviewContext: createReplenishmentReviewContext({
      database,
      terms: supplierTerms,
      inputs: createPurchasingInputs(database, authority(database)),
      procurement,
    }),
    enabled: options.execution.kind === 'enabled',
    ...(options.replenishmentTransport
      ? { transport: options.replenishmentTransport }
      : {}),
    ...(options.refreshStock ? { refreshStock: options.refreshStock } : {}),
  });
  const coordination = createCoordination(database, identity, createAuditLog);
  const adaptiveFieldWorkflows = createAdaptiveFieldWorkflows(database, {
    fields: adaptiveFieldService,
    policies: safety.policies,
    refreshContext: identity.refreshContext,
    effects: adaptiveFieldEffects,
    admission: safety.execution,
    provisioning: safety.provisioning,
    resolveContext: (run) =>
      identity.resolveWorkflowContext(run.actor.id, run.tenantId, run.id),
    run: createWorkflowTriggerStore(database).run,
    version: async (context, id, version) => {
      const found = await createWorkflowTriggerStore(database).version(
        context,
        id,
        version,
      );

      return found?.format === 'workflow/2' ? found : null;
    },
    outputs: async (context, runId) =>
      (await createProcessStepStore(database).list(context, [runId])).get(
        runId,
      ) ?? [],
    enabled:
      options.execution.kind === 'enabled' && !!options.replenishmentTransport,
  });
  adaptiveFieldEligibility = adaptiveFieldWorkflows.eligible;
  const codeProcesses = createCodeProcesses(
    database,
    identity,
    options.replenishmentTransport,
    adaptiveFieldWorkflows,
  );
  const scopedFollowUp: ReturnType<typeof createScopedSupplierFollowUp> =
    createScopedSupplierFollowUp({
      database,
      identity,
      commitments,
      safety,
      runCurrent: (context, runId) => caseWorkflows.runCurrent(context, runId),
      notifyDecision: (context, runId) =>
        caseWorkflows.notifyDecision(context, runId),
      // Only positive source proof classifies a submitted order. Missing live proof blocks promotion.
      environment: createFollowUpEnvironmentReader({
        commitments,
        connectionEnvironment:
          options.connectionEnvironment ??
          (async () => ({ environment: 'unknown' as const, provenance: null })),
      }),
      ...(options.followUps?.supplierWaitSeconds !== undefined
        ? { waitMs: options.followUps.supplierWaitSeconds * 1000 }
        : {}),
    });
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
        recordSupplierFollowUp: scopedFollowUp.service.record,
        managedSupplierFollowUp: safety.autonomy.managed,
        verifySupplierFollowUp: scopedFollowUp.service.verified,
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
  const { drafts, draftTests, generation, templates } = createWorkflowAuthoring(
    {
      database,
      identity,
      caseWorkflows,
      codeProcesses,
      library,
      playbooks,
      replenishment,
      release: purchasingRelease,
      modelGateway: options.modelGateway,
      availability: options.authoring,
      improvementControls: options.workflowImprovementControls,
    },
  );
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
    async (context, requests) => {
      if (!(await purchasingRelease(context.tenantId, 'action-review-diffs')))
        return new Map();

      return createActionDiffReader(database)(
        context,
        requests.map((request) => ({
          id: request.id,
          reference: { proposalId: request.proposalId },
          observedAt: null,
        })),
      );
    },
  );
  const nativeStock = createNativeStockRuntime(
    database,
    identity,
    (context) => erpEnabledForTenant(context.tenantId),
    authority,
    options.nativeStockReader,
    (context) =>
      purchasingRelease(context.tenantId, 'purchasing-stock-booking'),
  );
  const { assignments: decisionAssignments, decisions } =
    createDecisionServices(
      database,
      identity,
      {
        adaptiveFieldWorkflows,
        apps: options.decisionSources ?? [],
        cases: detection.cases,
        caseWorkflows,
        commitments,
        coordination,
        messaging,
        nativeStock,
        orderChanges,
        purchasing,
        replenishment,
        returnCases,
        returnDeadlines,
        scopedFollowUp,
      },
      (tenantId) => purchasingRelease(tenantId, 'action-review-diffs'),
    );
  const {
    changes,
    customers,
    evidence,
    fulfillment,
    insights,
    inventory,
    metrics,
    operationalSummary,
    orders,
    procurementContext,
    products,
    records,
    returns,
  } = createReadModelServices({
    database,
    identity,
    authority,
    hiddenOrderSources,
    ...(options.actionPermission
      ? { actionPermission: options.actionPermission }
      : {}),
    commitments,
    ...(options.evidenceSources
      ? { evidenceSources: options.evidenceSources }
      : {}),
    procurement,
    release: purchasingRelease,
  });
  const assistant = createWorkspaceAssistant({
    contextualEnabled: (context) =>
      purchasingRelease(context.tenantId, 'contextual-record-assistance'),
    gateway: options.modelGateway ?? null,
    availability: options.assistant ?? { available: false, reason: null },
    reads: {
      orders,
      issues: detection.cases,
      customers,
      insights,
      reviewIssue: desk.review,
      inventory,
      fulfillment,
      returns,
    },
    refreshContext: identity.refreshContext,
    observability: options.observability,
  });

  const adaptive = createAdaptiveWorkspaceRuntime({
    database,
    identity,
    ...(options.observability ? { observability: options.observability } : {}),
    ...(options.modelGateway ? { model: options.modelGateway } : {}),
    modelAvailable: options.authoring?.available ?? false,
    owners: {
      orders,
      inventory,
      fulfillment,
      returns,
      products,
      customers,
      decisions,
      cases: detection.cases,
      procurement,
      commitments,
      supplierEmail,
      workflows,
    },
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
      activity: createWorkspaceActivity(
        database,
        identity.refreshContext,
        createAuditLog(database),
      ),
      adaptive,
      assistant,
      cases: detection.cases,
      changes,
      commitments,
      connectionCoverage: createConnectionCoverage(database),
      customerErasure: createCustomerErasure({
        db: database,
        audit: createAuditLog,
        refreshContext: identity.refreshContext,
      }),
      customers,
      decisionAssignments,
      decisions,
      desk,
      draftTests,
      evidence,
      fieldWorkflows: adaptiveFieldWorkflows,
      fulfillment,
      governedFollowUps: scopedFollowUp.service,
      incoming,
      insights,
      inventory,
      inventoryLedger: createInventoryLedgerRuntime(database, identity),
      learning: createResolutionLearning(database, identity.refreshContext),
      measurements: createResolutionMeasurements(
        database,
        identity.refreshContext,
      ),
      messaging: messaging.service,
      messagingDocuments: messaging.documents,
      messagingReplies: messaging.replies,
      metrics,
      nativeStock,
      operationalSummary,
      operations: createOperationsOverview(
        detection.cases,
        createConnectionCoverage(database),
        () => new Date(),
        createResolutionMetricReader(database),
        createPendingStockSyncReader(database),
      ),
      orderChanges,
      orders,
      playbooks: library,
      procurement,
      procurementContext,
      products,
      purchasing,
      purchasingOutcomes,
      records,
      returnActions,
      returnCases,
      returnDeadlines,
      returnExchanges,
      returns,
      sales: createSalesRuntime(
        database,
        identity,
        (context) => erpEnabledForTenant(context.tenantId),
        authority,
      ),
      scopedAutonomy: safety.autonomy,
      shadow: createShadowEvaluations(database, identity.refreshContext),
      sourceAuthority: authority(database),
      supplierEmail,
      supplierTerms,
      workflowDrafts: drafts,
      workflowGeneration: generation,
      workflowTemplates: templates,
      workflows,
    },
  };
}
