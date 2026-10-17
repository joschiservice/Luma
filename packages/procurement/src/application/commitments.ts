import type { AuditEntry } from '@luma/audit';
import type {
  ExternalId,
  SupplierOrderSnapshot,
  SupplierSnapshot,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import type { ModelGateway, ModelSchema, TraceContext } from '@luma/platform';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import type {
  Commitment,
  CommitmentKind,
  Communication,
  Extraction,
  FollowUp,
  PurchasingObservation,
  Submission,
} from '../domain/commitments.js';
import type {
  PurchaseOrder,
  Supplier,
  SupplierLinkInput,
} from '../domain/procurement.js';
import type { PurchasingTimelineEntry } from '../domain/purchasing-timeline.js';
import { createCommitmentContext } from './commitment-context.js';
import { createSubmissionExecution } from './commitment-execution.js';
import { createSupplierLinks } from './commitment-links.js';
import { createCommitmentLists } from './commitment-lists.js';
import { createSupplierMessages } from './commitment-messages.js';
import { createReceipts } from './commitment-receipts.js';
import { createCommitmentRecords } from './commitment-records.js';
import { createSupplierResponses } from './commitment-responses.js';
import { createSubmissionRequests } from './commitment-submissions.js';
import type { CustomFieldDefinition } from './custom-fields.js';
import type { ExtractionOutput } from './extraction.js';
import type {
  ListPosition,
  Positioned,
  PurchaseOrderFilter,
  StoredPurchaseOrderSort,
} from './lists.js';
import type { ProcurementEvent } from './procurement.js';
import type { PurchasingReadEvidence } from './purchasing-reads.js';

/**
 * A connection that can act as a purchasing system.
 *
 * @public Declaration emit names it in the inferred type of `createSupplierCommitmentService`.
 */
export interface PurchasingConnection {
  id: string;
  label: string;
  provider: string | null;
  status: string;
  canSubmit: boolean;
  canReadOrders: boolean;
  canListSuppliers: boolean;
}

/** @public Declaration emit names it in the inferred type of `createSupplierCommitmentService`. */
export interface PurchasingSupplier extends SupplierSnapshot {
  externalId: string;
  scopeKey: string;
}

export interface PurchasingOrder {
  observationId: string;
  /** When the read started, on Luma's clock. */
  observedAt: string;
  provider: string;
  adapterVersion: string;
  sourceUpdatedAt: string | null;
  sourceRevision: string | null;
  /** Partial when any page of the query was incomplete; it cannot rule out other matches. */
  completeness: 'complete' | 'partial';
  externalId: string;
  scopeKey: string;
  data: SupplierOrderSnapshot;
}

type PurchasingResult<T> =
  { ok: true; value: T } | { ok: false; reason: string };

/** Reads the merchant's purchasing system through installed connections. */
export interface PurchasingSystem {
  connections(context: TenantContext): Promise<PurchasingConnection[]>;
  suppliers(
    context: TenantContext,
    connectionId: string,
    query: { supplier?: ExternalId; cursor?: string },
  ): Promise<
    PurchasingResult<{ items: PurchasingSupplier[]; nextCursor: string | null }>
  >;
  orders(
    context: TenantContext,
    connectionId: string,
    query: {
      order?: ExternalId;
      created?: { lumaOrderId: string; createdSince: string };
    },
  ): Promise<PurchasingResult<PurchasingOrder[]>>;
}

/** Execution state of a submission action, as Action Admission recorded it. */
export type SubmissionExecution =
  | { state: 'not_started' }
  | { state: 'not_executed'; reason: 'observe_only' }
  | { state: 'withheld'; reason: string }
  | { state: 'accepted' }
  | { state: 'verified' }
  | { state: 'failed'; reason: string }
  | { state: 'uncertain' };

/** Binds submissions to Action Admission, workspace policy and audited execution. */
export interface SubmissionAdmission {
  /** Reads effective workspace and connection write controls without provider calls. */
  writeMode?(
    context: TenantContext,
    connectionId: string,
  ): Promise<'observe_only' | 'writes_enabled'>;
  /** Binds the action to its admission step and evaluates policy with a fresh precondition check. */
  prepare(
    context: TenantContext,
    submission: Submission,
    action: ProposedAction,
  ): Promise<PolicyDecision>;
  decision(
    context: TenantContext,
    id: string,
  ): Promise<
    | (PolicyDecision & {
        approval?: { outcome: 'approved' | 'rejected'; approverId: string };
        requireIndependentApproval?: boolean;
      })
    | null
  >;
  respond(
    context: TenantContext,
    decisionId: string,
    outcome: 'approved' | 'rejected',
    expiresAt: string,
  ): Promise<void>;
  /** Dispatches once; repeated calls return the recorded attempt. */
  execute(
    context: TenantContext,
    submission: Submission,
  ): Promise<SubmissionExecution>;
  /** Re-runs verification only; never dispatches again. */
  reconcile(
    context: TenantContext,
    submission: Submission,
  ): Promise<SubmissionExecution>;
  get(
    context: TenantContext,
    submission: Submission,
  ): Promise<SubmissionExecution>;
}

/** Stores procurement commitments; every transaction shares the procurement tenant lock. */
export interface CommitmentTransaction {
  order(id: string): Promise<PurchaseOrder | null>;
  orders(): Promise<PurchaseOrder[]>;
  /**
   * Purchase orders matching `filter`. With `order`, rows follow its sort after `order.after`;
   * without it, newest first. Reads at most `limit` rows when given.
   */
  purchaseOrders(
    filter: PurchaseOrderFilter,
    order: {
      sort: StoredPurchaseOrderSort;
      direction: 'asc' | 'desc';
      after: ListPosition | null;
    } | null,
    limit: number | null,
  ): Promise<Positioned<PurchaseOrder>[]>;
  /** Counts purchase orders matching `filter`. */
  countPurchaseOrders(filter: PurchaseOrderFilter): Promise<number>;
  /** Live custom fields of purchase orders among `ids`; archived and unknown IDs are absent. */
  customFields?(
    recordType: 'purchase_order',
    ids: string[],
  ): Promise<CustomFieldDefinition[]>;
  supplier(id: string): Promise<Supplier | null>;
  updateSupplier(supplier: Supplier): Promise<void>;
  history(orderId: string): Promise<ProcurementEvent[]>;
  /** Reads admitted plans, revisions and stock-action proof without provider calls. */
  timeline?(
    orderId: string,
    includeStock: boolean,
  ): Promise<PurchasingTimelineEntry[]>;
  /** Newest first. Without IDs, returns every submission. */
  submissions(orderIds?: string[]): Promise<Submission[]>;
  submission(id: string): Promise<Submission | null>;
  insertSubmission(submission: Submission): Promise<void>;
  saveSubmission(submission: Submission, settled: boolean): Promise<void>;
  /** Unsettled submissions in active states, oldest first. */
  liveSubmissions(principalId: string): Promise<Submission[]>;
  communications(filter: {
    orderIds?: string[];
    supplierId?: string;
  }): Promise<Communication[]>;
  communication(id: string): Promise<Communication | null>;
  communicationByKey(key: string): Promise<Communication | null>;
  insertCommunication(communication: Communication, key: string): Promise<void>;
  purgeCommunication(communication: Communication): Promise<void>;
  extractions(communicationIds: string[]): Promise<Extraction[]>;
  insertExtraction(extraction: Extraction): Promise<void>;
  /** Without IDs, returns every commitment. Ordered by recorded time. */
  commitments(orderIds?: string[]): Promise<Commitment[]>;
  commitment(id: string): Promise<Commitment | null>;
  /** Inserts unless the source key exists; returns the stored commitment. */
  insertCommitment(
    commitment: Commitment,
    sourceKey: string,
  ): Promise<Commitment>;
  reviewCommitment(commitment: Commitment): Promise<void>;
  latestObservation(orderId: string): Promise<PurchasingObservation | null>;
  observations(
    orderId: string,
    limit: number,
  ): Promise<PurchasingObservation[]>;
  insertObservation(observation: PurchasingObservation): Promise<void>;
  /** Stores a cited purchasing-system read; an already stored read is kept unchanged. */
  recordRead(evidence: PurchasingReadEvidence): Promise<void>;
  followUps(orderIds?: string[]): Promise<FollowUp[]>;
  /** Returns false when the key was already answered. */
  insertFollowUp(followUp: FollowUp): Promise<boolean>;
  command(id: string): Promise<{ digest: string; result: unknown } | null>;
  saveCommand(id: string, digest: string, result: unknown): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  /** Purchasing-system SKU identities for order-line SKUs, by connection. */
  skuIdentities(
    connectionId: string,
    skus: string[],
  ): Promise<Map<string, ExternalId>>;
}

export interface CommitmentStore {
  transaction<T>(
    tenantId: string,
    write: boolean,
    operation: (tx: CommitmentTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface CommitmentDependencies {
  /** Resolves recorded purchasing actors and explicit admission or draft workflow provenance for authorized history. */
  timelineActors?(
    context: TenantContext,
    entries: PurchasingTimelineEntry[],
    workflowRunId?: string,
  ): Promise<PurchasingTimelineEntry[]>;

  /** Reads owner-provided stock receipt proof; observation remains distinct from a recorded receipt. */
  additionalTimeline?(
    context: TenantContext,
    orderId: string,
  ): Promise<PurchasingTimelineEntry[]>;
  store: CommitmentStore;
  purchasing: PurchasingSystem | null;
  admission: SubmissionAdmission | null;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  /** Resolves a stored principal's current workspace context for background work. */
  principal(
    principalId: string,
    tenantId: string,
    requestId: string,
  ): Promise<TenantContext>;
  /** Moves a draft to open after its submission is verified. */
  openOrder(
    context: TenantContext,
    order: PurchaseOrder,
    commandId: string,
    reason: string,
  ): Promise<void>;
  /** Whether replenishment independently verified the draft, by workflow run. */
  verifiedDrafts(
    context: TenantContext,
    runIds: string[],
  ): Promise<Set<string>>;
  model: {
    gateway: ModelGateway | null;
    available: boolean;
    reason: string;
    output: ModelSchema<ExtractionOutput>;
  };
  trace(context: TenantContext): TraceContext;
  retentionDays: number;
  /** Workspace flag admission for manual receipt and reconciliation writes. */
  shortfallAvailable?(context: TenantContext): Promise<boolean>;
  reconciliationAvailable?(context: TenantContext): Promise<boolean>;
  /** Projects verified expected arrivals through Inventory after procurement commits; no provider stock is changed. */
  incomingChanged?(context: TenantContext, orderId: string): Promise<void>;

  digest(value: unknown): string;
  id(): string;
  /** Stable UUID derived from a name. */
  uuid(name: string): string;
  now(): Date;
  parse: {
    receipt?(input: unknown): {
      id: string;
      lineId: string;
      kind: 'received' | 'shortage' | 'damaged';
      quantity: number;
      expectedCommitmentId: string | null;
      damagedQuantity?: number | undefined;
      expectedDamagedCommitmentId?: string | null | undefined;
      receivedAt: string;
      condition: 'good' | 'mixed' | 'damaged';
      reason: string;
      evidence: string[];
    };
    link(input: unknown): SupplierLinkInput;
    submission(input: unknown): { id: string; requestedDeliveryDate: string };
    decision(input: unknown): {
      decisionId: string;
      outcome: 'approved' | 'rejected';
    };
    message(input: unknown): {
      id: string;
      channel: Communication['channel'];
      from: string;
      subject: string;
      body: string;
      receivedAt: string;
      messageId: string | null;
    };
    commitment(input: unknown): {
      id: string;
      kind: Exclude<CommitmentKind, 'received' | 'shortage' | 'damaged'>;
      lineId: string | null;
      quantity: number | null;
      date: string | null;
      text: string | null;
      communicationId: string | null;
      span: { start: number; end: number } | null;
      supersedes: string | null;
      reason: string | null;
    };
    review(input: unknown): {
      outcome: 'confirmed' | 'rejected';
      acceptChange: boolean;
    };
    followUp(input: unknown): {
      id: string;
      key: string;
      response: FollowUp['response'];
      note: string;
      nextCheckAt: string | null;
      expectedOrderRevision?: number | undefined;
      expectedScopeFingerprint?: string | undefined;
    };
  };
}

/** What a person can do with a submission now, from persisted state. */
export interface SubmissionView extends Submission {
  observeOnly?: boolean;
  approvalOutcome: 'approved' | 'rejected' | null;
  canApprove: boolean;
  canSend: boolean;
  canCheck: boolean;
  message: string;
}

/**
 * Owns the supplier lifecycle after a purchase order is drafted: approval-controlled submission
 * to a purchasing system, independently read confirmations and receipts, supplier messages with
 * cited extraction, reviews, and follow-ups on missed or changed commitments.
 */
export function createSupplierCommitments(deps: CommitmentDependencies) {
  const context = createCommitmentContext(deps);
  const execution = createSubmissionExecution(context);
  const submissions = createSubmissionRequests(context, execution);
  const links = createSupplierLinks(context);
  const records = createCommitmentRecords(context, submissions, execution);
  const lists = createCommitmentLists(context);
  const messages = createSupplierMessages(context);
  const responses = createSupplierResponses(context);
  const receipts = createReceipts(context);

  return {
    connections: links.connections,
    purchasingSuppliers: links.purchasingSuppliers,
    linkSupplier: links.linkSupplier,
    order: records.order,
    summaries: lists.summaries,
    listOrders: lists.listOrders,
    confirmationOverdueSuppliers: lists.confirmationOverdueSuppliers,
    pending: records.pending,
    supplier: records.supplier,
    requestSubmission: submissions.requestSubmission,
    decideSubmission: submissions.decideSubmission,
    sendSubmission: submissions.sendSubmission,
    checkSubmission: submissions.checkSubmission,
    refresh: records.refresh,
    recordMessage: messages.recordMessage,
    extractAgain: messages.extractAgain,
    removeMessageText: messages.removeMessageText,
    shortfall: responses.shortfall,
    recordReceipt: receipts.recordReceipt,
    recordEmailSubmission: submissions.recordEmailSubmission,
    recordCommitment: responses.recordCommitment,
    reviewCommitment: responses.reviewCommitment,
    respond: responses.respond,
    tick: execution.tick,
    eligible: execution.eligible,
    verify: execution.verify,
    submissionForAction: execution.submissionForAction,
  };
}

export type SupplierCommitments = ReturnType<typeof createSupplierCommitments>;
