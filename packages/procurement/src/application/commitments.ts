import type { AuditEntry } from '@luma/audit';
import type {
  ExternalId,
  SupplierOrderSnapshot,
  SupplierSnapshot,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  IdentityError,
  isAppPermission,
  MembershipSuspendedError,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import type { ModelGateway, ModelSchema, TraceContext } from '@luma/platform';
import { canonicalJson } from '@luma/platform';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import type {
  Attention,
  Commitment,
  CommitmentKind,
  Communication,
  Extraction,
  FollowUp,
  OrderProgress,
  OrderStage,
  PurchasingObservation,
  Submission,
} from '../domain/commitments.js';
import {
  defaultSupplierTerms,
  isMaterialChange,
  orderProgress,
  orderStage,
  reviewReasons,
} from '../domain/commitments.js';
import { followUpScopeFingerprint } from '../domain/follow-up-snapshot.js';
import { orderValue } from '../domain/order-value.js';
import type {
  PurchaseOrder,
  Supplier,
  SupplierLinkInput,
} from '../domain/procurement.js';
import {
  purchasingTimeline,
  type PurchasingTimelineEntry,
} from '../domain/purchasing-timeline.js';
import {
  type CustomFieldDefinition,
  customFieldIds,
  customListFields,
  customSortField,
  readableCustomFields,
  withCustomReader,
} from './custom-fields.js';
import {
  extractFacts,
  type ExtractionOutput,
  messageText,
} from './extraction.js';
import { listQueryError, planListWhere } from './list-conditions.js';
import {
  comparePositions,
  type ListCustomField,
  type ListGroupKey,
  type ListPosition,
  listScope,
  listTimeZone,
  type OrderSummary,
  type Positioned,
  purchaseOrderDirection,
  type PurchaseOrderFilter,
  type PurchaseOrderList,
  type PurchaseOrderListQuery,
  readListCursor,
  type StoredPurchaseOrderSort,
  writeListCursor,
} from './lists.js';
import type { ProcurementEvent } from './procurement.js';
import {
  derivedKeyComparator,
  derivedPosition,
  groupMember,
  groupPurchaseOrders,
  isStoredSort,
  type PositionedRow,
  purchaseOrderFields,
  purchaseOrderGroupField,
  type PurchaseOrderRow,
} from './purchase-order-list.js';

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
  observedAt: string;
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

const hour = 3_600_000;

// Activity shows `reason` as the event summary.
const auditSummaries: Record<string, string> = {
  'purchase_order.submission_requested':
    'Approval requested to send to the supplier',
  'purchase_order.submission_approved': 'Sending to the supplier approved',
  'purchase_order.submission_rejected': 'Sending to the supplier rejected',
  'purchase_order.submitted': 'Placed in the purchasing system and verified',
  'purchase_order.message_recorded': 'Supplier message recorded',
  'purchase_order.message_read': 'Supplier message read',
  'purchase_order.message_removed': 'Supplier message text removed',
  'purchase_order.commitment_recorded': 'Supplier commitment recorded',
  'purchase_order.commitment_reviewed': 'Supplier commitment reviewed',
  'purchase_order.follow_up': 'Supplier follow-up recorded',
  'supplier.updated': 'Supplier purchasing link updated',
};

/**
 * Owns the supplier lifecycle after a purchase order is drafted: approval-controlled submission
 * to a purchasing system, independently read confirmations and receipts, supplier messages with
 * cited extraction, reviews, and follow-ups on missed or changed commitments.
 */
export function createSupplierCommitments(deps: CommitmentDependencies) {
  async function authorize(context: TenantContext, write = false) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');
    if (fresh.actor.id !== context.actor.id)
      throw new IdentityError(403, 'FORBIDDEN', 'Sign in again to continue.');

    return fresh;
  }

  const conflict = (message: string): never => {
    throw new IdentityError(409, 'CONFLICT', message);
  };
  const notFound = (message: string): never => {
    throw new IdentityError(404, 'NOT_FOUND', message);
  };
  const unavailable = (message: string): never => {
    throw new IdentityError(503, 'SERVICE_UNAVAILABLE', message);
  };

  function audit(
    context: TenantContext,
    type: string,
    eventId: string,
    orderId: string,
    details: Record<string, string>,
    evidenceRefs: string[] = [],
  ): AuditEntry {
    return {
      id: deps.uuid(`audit:${type}:${eventId}`),
      tenantId: context.tenantId,
      eventKey: `procurement:${type}:${eventId}`,
      eventType: type,
      schemaVersion: 1,
      occurredAt: deps.now().toISOString(),
      actor: { kind: 'user', id: context.actor.id },
      correlationId: orderId,
      proposalId: orderId,
      actionHash: deps.digest({ type, eventId, details }),
      evidenceRefs: [orderId, ...evidenceRefs],
      details: {
        ...(type.startsWith('purchase_order.')
          ? { purchaseOrderId: orderId }
          : {}),
        reason: auditSummaries[type] ?? type,
        ...details,
      },
    };
  }

  /** Runs a write once per command ID; an exact retry returns the original result. */
  async function command<T>(
    context: TenantContext,
    id: string,
    request: unknown,
    operation: (tx: CommitmentTransaction) => Promise<T>,
  ): Promise<T> {
    const digest = deps.digest({ actorId: context.actor.id, request });

    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const prior = await tx.command(id);
      if (prior) {
        if (prior.digest !== digest)
          conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return prior.result as T;
      }
      const result = await operation(tx);
      await tx.saveCommand(id, digest, result);

      return result;
    });
  }

  const terms = (supplier: Supplier | null) => ({
    confirmationHours:
      supplier?.confirmationHours ?? defaultSupplierTerms.confirmationHours,
  });

  function progressFor(
    order: PurchaseOrder,
    data: {
      submissions: Submission[];
      commitments: Commitment[];
      followUps: FollowUp[];
      supplier: Supplier | null;
      verified: Set<string>;
      /** Evaluation time; defaults to now. */
      now?: Date;
    },
  ): { progress: OrderProgress; submission: Submission | null } {
    const submission =
      data.submissions.find((s) => s.purchaseOrderId === order.id) ?? null;

    return {
      submission,
      progress: orderProgress({
        order,
        submission,
        commitments: data.commitments.filter(
          (c) => c.purchaseOrderId === order.id,
        ),
        followUps: data.followUps.filter((f) => f.purchaseOrderId === order.id),
        terms: terms(data.supplier),
        draftVerified:
          !!order.origin.workflowRunId &&
          data.verified.has(order.origin.workflowRunId),
        supplierLinked: !!data.supplier?.link,
        now: data.now ?? deps.now(),
      }),
    };
  }

  /** The list summary of one order: stage, expected date, attention and next owner. */
  function summaryOf(
    order: PurchaseOrder,
    data: {
      submissions: Submission[];
      commitments: Commitment[];
      followUps: FollowUp[];
      supplier: Supplier | null;
      verified: Set<string>;
      now?: Date;
    },
  ): OrderSummary {
    const { progress, submission } = progressFor(order, data);

    return {
      id: order.id,
      stage: orderStage(order, submission, progress),
      expectedDate: progress.expectedDate,
      // A pending approval shows in the stage; count what needs an answer beyond it.
      attention: progress.attention.filter(
        (a) => a.kind !== 'submission_approval',
      ).length,
      attentionKinds: [
        ...new Set(
          progress.attention
            .filter((a) => a.kind !== 'submission_approval')
            .map((a) => a.kind),
        ),
      ],
      overdue: progress.attention.some((a) =>
        ['confirmation_overdue', 'delivery_overdue'].includes(a.kind),
      ),
      nextOwner: progress.next.owner,
      externalOrderNumber: submission?.externalOrder?.orderNumber ?? null,
      confirmationDueAt: progress.confirmationDueAt,
      nextCheckAt: progress.nextCheckAt,
      value: orderValue(order),
    };
  }

  /**
   * Summarizes `orders` at `now` from their submissions, commitments, follow-ups and supplier
   * terms, read in one procurement transaction. Without `ids`, reads related records of every order.
   */
  async function summarize(
    tx: CommitmentTransaction,
    orders: PurchaseOrder[],
    now: Date,
    ids?: string[],
  ) {
    const group = <T extends { purchaseOrderId: string }>(rows: T[]) => {
      const grouped = new Map<string, T[]>();
      for (const row of rows) {
        const list = grouped.get(row.purchaseOrderId) ?? [];
        list.push(row);
        grouped.set(row.purchaseOrderId, list);
      }

      return grouped;
    };
    const submissions = group(await tx.submissions(ids));
    const commitments = group(await tx.commitments(ids));
    const followUps = group(await tx.followUps(ids));
    const suppliers = new Map(
      await Promise.all(
        [...new Set(orders.map((o) => o.supplierId))].map(
          async (id) => [id, await tx.supplier(id)] as const,
        ),
      ),
    );

    return new Map(
      orders.map((order) => [
        order.id,
        summaryOf(order, {
          submissions: submissions.get(order.id) ?? [],
          commitments: commitments.get(order.id) ?? [],
          followUps: followUps.get(order.id) ?? [],
          supplier: suppliers.get(order.supplierId) ?? null,
          // Draft verification only explains the drafted milestone, not the summary.
          verified: new Set(),
          now,
        }),
      ]),
    );
  }

  /** Whether a summary matches a stage filter; `attention` means any open item to answer. */
  const inStage = (
    summary: OrderSummary | undefined,
    stage: PurchaseOrderListQuery['stage'],
  ) =>
    !!summary &&
    (stage === undefined ||
      (stage === 'attention'
        ? summary.attention > 0
        : summary.stage === stage));

  async function submissionView(
    context: TenantContext,
    submission: Submission,
  ): Promise<SubmissionView> {
    const decision =
      submission.decisionId && deps.admission
        ? await deps.admission.decision(context, submission.decisionId)
        : null;
    const expired =
      submission.state === 'approval_required' &&
      Date.parse(submission.expiresAt) <= deps.now().getTime();
    const observeOnly =
      submission.state === 'not_executed' ||
      (['approval_required', 'approved'].includes(submission.state) &&
        (await deps.admission?.writeMode?.(
          context,
          submission.connectionId,
        )) === 'observe_only');
    const requester = context.actor.id === submission.requestedBy;
    const manager = hasPermission(context, 'procurement.manage');
    // Approvers also need permission to approve changes and any app permission the
    // purchasing capability declares, as policy checks when they respond.
    const approver =
      manager &&
      hasPermission(context, 'decisions.respond') &&
      (!decision?.permission ||
        !isAppPermission(decision.permission) ||
        hasPermission(context, decision.permission));
    const messages: Record<Submission['state'], string> = {
      not_executed:
        'Observe-only. Would run when writes are enabled. Nothing was sent.',
      approval_required:
        requester && decision?.requireIndependentApproval !== false
          ? 'Waiting for someone else who can approve changes to approve sending this order.'
          : 'Check the supplier, lines and requested date before approving. Luma places the order in the purchasing system right after approval.',
      approved: 'Approved. Luma is placing the order in the purchasing system.',
      rejected: 'Sending was rejected. Nothing was sent.',
      expired: 'The approval request expired. Nothing was sent.',
      submitting: 'Luma is placing the order in the purchasing system.',
      uncertain:
        'The purchasing system did not confirm the request. Luma checks whether the order was created and will not send it again.',
      submitted:
        'An independent read found the order in the purchasing system. The purchasing system sends it to the supplier.',
      failed:
        submission.failure ?? 'The purchasing system did not create the order.',
    };

    return {
      ...submission,
      observeOnly,
      state: expired ? 'expired' : submission.state,
      approvalOutcome: decision?.approval?.outcome ?? null,
      canApprove:
        submission.channel !== 'email' &&
        !observeOnly &&
        !expired &&
        approver &&
        (!requester || decision?.requireIndependentApproval === false) &&
        submission.state === 'approval_required' &&
        !decision?.approval,
      canSend:
        submission.channel !== 'email' &&
        !observeOnly &&
        !expired &&
        requester &&
        submission.state === 'approved',
      canCheck:
        submission.channel !== 'email' &&
        manager &&
        ['uncertain', 'submitting'].includes(submission.state),
      message: observeOnly
        ? messages.not_executed
        : expired
          ? messages.expired
          : messages[submission.state],
    };
  }

  async function verified(context: TenantContext, orders: PurchaseOrder[]) {
    const runs = orders
      .map((o) => o.origin.workflowRunId)
      .filter((v): v is string => !!v);

    return runs.length
      ? deps.verifiedDrafts(context, runs).catch(() => new Set<string>())
      : new Set<string>();
  }

  async function lineMapping(
    tx: CommitmentTransaction,
    order: PurchaseOrder,
    connectionId: string,
  ) {
    const identities = await tx.skuIdentities(
      connectionId,
      order.lines.map((line) => line.sku),
    );

    return order.lines.map((line) => ({
      line,
      sku: identities.get(line.sku) ?? null,
    }));
  }

  /** Explains whether this order can be sent through its supplier's purchasing system. */
  async function readiness(
    context: TenantContext,
    tx: CommitmentTransaction,
    order: PurchaseOrder,
    supplier: Supplier | null,
  ) {
    const blockers: string[] = [];
    if (order.authority !== 'luma')
      blockers.push('This order is managed in an external system.');
    if (!['draft', 'open'].includes(order.status))
      blockers.push('Only draft and open orders can be sent.');
    if (!deps.admission || !deps.purchasing)
      blockers.push(
        'Sending orders is unavailable on this server. Ask an administrator to enable execution.',
      );
    const link = supplier?.link ?? null;
    if (!link)
      blockers.push(
        'Link this supplier to its purchasing-system record before sending orders.',
      );
    let connection: PurchasingConnection | null = null;
    if (link && deps.purchasing) {
      connection =
        (await deps.purchasing.connections(context)).find(
          (c) => c.id === link.connectionId,
        ) ?? null;
      if (!connection || connection.status !== 'active')
        blockers.push(
          'The supplier’s purchasing-system connection is not active. Check the connection in Apps.',
        );
      else if (!connection.canSubmit || !connection.canReadOrders)
        blockers.push(
          `${connection.label} is not allowed to create and read purchase orders. Reconnect it with purchase-order access.`,
        );
    }
    const lines = link ? await lineMapping(tx, order, link.connectionId) : [];
    for (const entry of lines.filter((l) => !l.sku))
      blockers.push(
        `${entry.line.sku} has no linked item in ${connection?.label ?? 'the purchasing system'}. Link the SKU in Products first.`,
      );

    return {
      ready: blockers.length === 0,
      blockers,
      connection: connection
        ? { id: connection.id, label: connection.label }
        : null,
      lines: lines.map((l) => ({
        lineId: l.line.id,
        sku: l.line.sku,
        mapped: !!l.sku,
      })),
    };
  }

  async function saveSubmission(
    tx: CommitmentTransaction,
    submission: Submission,
    patch: Partial<Submission>,
    settled = false,
  ) {
    const next = {
      ...submission,
      ...patch,
      updatedAt: deps.now().toISOString(),
    };
    await tx.saveSubmission(next, settled);

    return next;
  }

  /**
   * Finds the purchasing-system order created for a submission and records it as evidence.
   * Returns null when the read fails or the order is not there.
   */
  async function locate(context: TenantContext, submission: Submission) {
    if (!deps.purchasing) return null;
    const result = await deps.purchasing.orders(
      context,
      submission.connectionId,
      submission.externalOrder
        ? {
            order: {
              externalId: submission.externalOrder.externalId,
              scopeKey: submission.supplier.scopeKey,
            },
          }
        : {
            created: {
              lumaOrderId: submission.purchaseOrderId,
              createdSince: new Date(
                Date.parse(submission.requestedAt) - hour,
              ).toISOString(),
            },
          },
    );
    if (!result.ok) return null;
    const matches = result.value.filter(
      (o) => o.data.lumaOrderId === submission.purchaseOrderId,
    );

    return matches.length === 1 ? matches[0]! : null;
  }

  /** Whether a purchasing-system order carries exactly the approved supplier and lines. */
  function matchesSubmission(submission: Submission, order: PurchasingOrder) {
    if (order.data.supplier.externalId !== submission.supplier.externalId)
      return false;
    const lines = order.data.lines;

    return (
      lines.length === submission.lines.length &&
      submission.lines.every((line) =>
        lines.some(
          (l) =>
            l.sku?.externalId === line.sku.externalId &&
            Math.abs(Number(l.quantity.amount) - line.quantity) < 1e-6,
        ),
      )
    );
  }

  /** Records an observation and the commitments it evidences; repeated values are not duplicated. */
  async function incomingResult<T>(
    context: TenantContext,
    orderId: string,
    result: Promise<T>,
  ): Promise<T> {
    const value = await result;
    await deps.incomingChanged?.(context, orderId);

    return value;
  }

  async function observe(
    context: TenantContext,
    submission: Submission,
    found: PurchasingOrder,
  ) {
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const order = await tx.order(submission.purchaseOrderId);
      if (!order) return;
      const mappedLines = await lineMapping(tx, order, submission.connectionId);
      const lineFor = (sku: ExternalId | null) =>
        mappedLines.find(
          (entry) =>
            entry.sku?.externalId === sku?.externalId &&
            entry.sku?.scopeKey === sku?.scopeKey,
        )?.line.id ??
        submission.lines.find(
          (entry) =>
            entry.sku.externalId === sku?.externalId &&
            entry.sku.scopeKey === sku?.scopeKey,
        )?.lineId ??
        null;
      const lines = found.data.lines.map((l) => ({
        lineId: lineFor(l.sku),
        externalLineId: l.id.externalId,
        quantity: l.quantity.amount,
        deliveredQuantity: l.deliveredQuantity,
        confirmedQuantity: l.confirmedQuantity,
        confirmedDeliveryDate: l.confirmedDeliveryDate,
        confirmed: l.confirmed,
      }));
      const digest = deps.digest({
        status: found.data.status,
        confirmed: found.data.confirmed,
        lines,
      });
      const latest = await tx.latestObservation(order.id);
      const observation: PurchasingObservation =
        latest?.digest === digest
          ? latest
          : {
              id: found.observationId,
              tenantId: context.tenantId,
              purchaseOrderId: order.id,
              submissionId: submission.id,
              connectionId: submission.connectionId,
              externalId: found.externalId,
              observedAt: found.observedAt,
              digest,
              status: found.data.status,
              orderNumber: found.data.orderNumber,
              confirmed: found.data.confirmed,
              lines,
            };
      if (observation !== latest) await tx.insertObservation(observation);
      const source = {
        kind: 'purchasing_system' as const,
        connectionId: submission.connectionId,
        observationId: observation.id,
        observedAt: observation.observedAt,
        externalOrderId: found.externalId,
      };
      const add = async (
        lineId: string,
        kind: CommitmentKind,
        value: { quantity?: number; date?: string },
      ) => {
        const id = deps.id();
        await tx.insertCommitment(
          {
            id,
            tenantId: context.tenantId,
            purchaseOrderId: order.id,
            lineId,
            kind,
            quantity: value.quantity ?? null,
            date: value.date ?? null,
            text: null,
            source,
            status: 'confirmed',
            reviewReasons: [],
            supersedes: null,
            recordedAt: observation.observedAt,
            recordedBy: { kind: 'luma', id: 'purchasing-system' },
            review: null,
          },
          `observed:${submission.id}:${lineId}:${kind}:${value.quantity ?? value.date}`,
        );
      };
      for (const line of lines) {
        const ordered = order.lines.find((l) => l.id === line.lineId);
        if (!line.lineId || !ordered) continue;
        const confirmedQuantity =
          line.confirmedQuantity !== null
            ? Number(line.confirmedQuantity)
            : line.confirmed || found.data.confirmed
              ? ordered.quantity
              : null;
        if (confirmedQuantity !== null)
          await add(line.lineId, 'confirmed_quantity', {
            quantity: confirmedQuantity,
          });
        if (line.confirmedDeliveryDate)
          await add(line.lineId, 'promised_date', {
            date: line.confirmedDeliveryDate,
          });
        const delivered = Number(line.deliveredQuantity ?? '0');
        if (delivered > 0)
          await add(line.lineId, 'received', { quantity: delivered });
      }
      const current = await tx.submission(submission.id);
      if (!current) return;
      const state = progressFor(order, {
        submissions: [current],
        commitments: await tx.commitments([order.id]),
        followUps: [],
        supplier: null,
        verified: new Set(),
      }).progress;
      const settled =
        ['closed', 'cancelled'].includes(order.status) ||
        state.lines.every((l) => l.stage === 'received');
      await saveSubmission(
        tx,
        current,
        {
          externalOrder: {
            externalId: found.externalId,
            orderNumber: found.data.orderNumber,
          },
        },
        settled,
      );
    });
    await deps.incomingChanged?.(context, submission.purchaseOrderId);
  }

  /** Applies an execution result to a submission and, once verified, locates the order. */
  async function settle(
    context: TenantContext,
    submissionId: string,
    execution: SubmissionExecution,
  ) {
    let submission = await deps.store.transaction(
      context.tenantId,
      false,
      (tx) => tx.submission(submissionId),
    );
    if (!submission) return null;
    if (execution.state === 'not_started') return submission;
    if (execution.state === 'not_executed')
      return deps.store.transaction(context.tenantId, true, async (tx) =>
        saveSubmission(tx, submission!, {
          state: 'not_executed',
          failure: null,
        }),
      );
    if (execution.state === 'withheld' || execution.state === 'failed')
      return deps.store.transaction(context.tenantId, true, async (tx) =>
        saveSubmission(tx, submission!, {
          state: 'failed',
          failure: execution.reason,
        }),
      );
    if (execution.state !== 'verified')
      return deps.store.transaction(context.tenantId, true, async (tx) =>
        saveSubmission(tx, submission!, { state: 'uncertain' }),
      );
    const found = await locate(context, submission);
    if (!found || !matchesSubmission(submission, found))
      return deps.store.transaction(context.tenantId, true, async (tx) =>
        saveSubmission(tx, submission!, { state: 'uncertain' }),
      );
    submission = await deps.store.transaction(
      context.tenantId,
      true,
      async (tx) => {
        const current = (await tx.submission(submissionId))!;
        if (current.state === 'submitted') return current;
        const saved = await saveSubmission(tx, current, {
          state: 'submitted',
          submittedAt: current.submittedAt ?? found.observedAt,
          externalOrder: {
            externalId: found.externalId,
            orderNumber: found.data.orderNumber,
          },
          failure: null,
        });
        await tx.audit(
          audit(
            context,
            'purchase_order.submitted',
            submissionId,
            saved.purchaseOrderId,
            {
              submissionId,
              connectionId: saved.connectionId,
              externalOrderId: found.externalId,
              orderNumber: found.data.orderNumber ?? '',
            },
            [found.observationId],
          ),
        );

        return saved;
      },
    );
    await observe(context, submission, found);
    const order = await deps.store.transaction(context.tenantId, false, (tx) =>
      tx.order(submission!.purchaseOrderId),
    );
    if (order?.status === 'draft')
      await deps
        .openOrder(
          context,
          order,
          deps.uuid(`submission-open:${submissionId}`),
          'Placed in the purchasing system and verified by an independent read',
        )
        .catch(() => undefined);

    return submission;
  }

  async function dispatch(context: TenantContext, submission: Submission) {
    if (!deps.admission) return submission;
    await deps.store.transaction(context.tenantId, true, async (tx) => {
      const current = await tx.submission(submission.id);
      if (current?.state === 'approved')
        await saveSubmission(tx, current, { state: 'submitting' });
    });
    let execution: SubmissionExecution;
    try {
      execution = await deps.admission.execute(context, submission);
    } catch {
      execution = await deps.admission
        .get(context, submission)
        .catch(() => ({ state: 'uncertain' }) as const);
      if (execution.state === 'not_started')
        execution = {
          state: 'failed',
          reason: 'The order could not be sent. Nothing was dispatched.',
        };
    }

    return settle(context, submission.id, execution);
  }

  function factSourceKey(
    communicationId: string,
    fact: {
      kind: string;
      lineId: string | null;
      quantity: number | null;
      date: string | null;
      text: string | null;
    },
  ) {
    return `message:${communicationId}:${deps.digest(fact)}`;
  }

  async function extractInto(
    context: TenantContext,
    communication: Communication,
    order: PurchaseOrder,
    attempt: number,
  ) {
    const submission = await deps.store.transaction(
      context.tenantId,
      false,
      async (tx) => (await tx.submissions([order.id]))[0] ?? null,
    );
    const requestedDate = submission?.requestedDeliveryDate ?? null;
    const result = await extractFacts({
      dataRegion: context.dataRegion,
      gateway: deps.model.gateway,
      output: deps.model.output,
      available: deps.model.available,
      trace: deps.trace(context),
      order,
      requestedDeliveryDate: requestedDate,
      message: {
        subject: communication.subject ?? '',
        body: communication.body ?? '',
        from: communication.from,
        receivedAt: communication.receivedAt,
      },
      id: deps.id,
    });

    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const extraction: Extraction = {
        id: deps.id(),
        tenantId: context.tenantId,
        communicationId: communication.id,
        attempt,
        state: result.state,
        relatesToOrder:
          result.state === 'completed' ? result.relatesToOrder : null,
        commitmentIds: [],
        discarded: result.state === 'completed' ? result.discarded : 0,
        model: result.state === 'completed' ? result.model : null,
        reason: result.state === 'completed' ? null : result.reason,
        createdAt: deps.now().toISOString(),
        createdBy: context.actor.id,
      };
      if (result.state === 'completed') {
        const multiLine = order.lines.length > 1;
        for (const fact of result.facts) {
          const line = order.lines.find((l) => l.id === fact.lineId) ?? null;
          const reasons = reviewReasons(fact, line, requestedDate, {
            confident: fact.confident && result.relatesToOrder,
            lineRequired:
              multiLine &&
              (fact.kind === 'confirmed_quantity' || fact.lineId !== null),
          });
          const lineId =
            line?.id ??
            (!multiLine && fact.kind === 'confirmed_quantity'
              ? order.lines[0]!.id
              : null);
          const stored = await tx.insertCommitment(
            {
              id: deps.id(),
              tenantId: context.tenantId,
              purchaseOrderId: order.id,
              lineId,
              kind: fact.kind,
              quantity: fact.quantity,
              date: fact.date,
              text: fact.text,
              source: {
                kind: 'communication',
                communicationId: communication.id,
                span: fact.span,
                extraction: {
                  id: extraction.id,
                  factId: fact.id,
                  model: result.model,
                },
              },
              status: reasons.length ? 'needs_review' : 'confirmed',
              reviewReasons: reasons,
              supersedes: null,
              recordedAt: extraction.createdAt,
              recordedBy: { kind: 'luma', id: 'supplier-extraction' },
              review: null,
            },
            factSourceKey(communication.id, {
              kind: fact.kind,
              lineId,
              quantity: fact.quantity,
              date: fact.date,
              text: fact.text,
            }),
          );
          extraction.commitmentIds.push(stored.id);
        }
      }
      await tx.insertExtraction(extraction);
      await tx.audit(
        audit(context, 'purchase_order.message_read', extraction.id, order.id, {
          communicationId: communication.id,
          state: extraction.state,
          facts: String(extraction.commitmentIds.length),
          model: extraction.model ?? '',
        }),
      );

      return extraction;
    });
  }

  async function record(context: TenantContext, orderId: string) {
    return deps.store.transaction(context.tenantId, false, async (tx) => {
      const order = await tx.order(orderId);
      if (!order) notFound('Purchase order not found');
      const supplier = await tx.supplier(order!.supplierId);
      const submissions = await tx.submissions([orderId]);
      const commitments = await tx.commitments([orderId]);
      const followUps = await tx.followUps([orderId]);
      const communications = await tx.communications({ orderIds: [orderId] });
      const extractions = await tx.extractions(communications.map((c) => c.id));

      return {
        order: order!,
        supplier,
        history: await tx.history(orderId),
        timelineEntries:
          (await tx.timeline?.(
            orderId,
            hasPermission(context, 'inventory.read'),
          )) ?? [],
        submissions,
        commitments,
        followUps,
        communications,
        extractions,
        observations: await tx.observations(orderId, 20),
        readiness: await readiness(context, tx, order!, supplier),
      };
    });
  }

  const service = {
    /** Lists connections usable as purchasing systems. */
    async connections(context: TenantContext) {
      context = await authorize(context);

      return deps.purchasing ? deps.purchasing.connections(context) : [];
    },
    /** Lists suppliers in a purchasing system for linking. */
    async purchasingSuppliers(
      context: TenantContext,
      connectionId: string,
      cursor?: string,
    ) {
      context = await authorize(context, true);
      if (!deps.purchasing)
        unavailable('Purchasing-system connections are unavailable.');
      const result = await deps.purchasing!.suppliers(context, connectionId, {
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) unavailable(result.reason);

      return result.ok ? result.value : { items: [], nextCursor: null };
    },
    /** Links a supplier to its purchasing-system record and sets follow-up terms. */
    async linkSupplier(
      context: TenantContext,
      supplierId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.link(input);
      let name: string | null = null;
      if (request.link) {
        if (!deps.purchasing)
          unavailable('Purchasing-system connections are unavailable.');
        const result = await deps.purchasing!.suppliers(
          context,
          request.link.connectionId,
          {
            supplier: {
              externalId: request.link.externalId,
              scopeKey: request.link.scopeKey,
            },
          },
        );
        if (!result.ok) unavailable(result.reason);
        const found = result.ok
          ? result.value.items.find(
              (s) => s.externalId === request.link!.externalId,
            )
          : undefined;
        if (!found)
          conflict('That supplier was not found in the purchasing system.');
        name = found!.name;
      }

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const supplier = await tx.supplier(supplierId);
        if (!supplier) notFound('Supplier not found');
        const revision = supplier!.revision ?? 1;
        if (revision !== request.expectedRevision)
          conflict('This supplier changed. Refresh and review it again.');
        const now = deps.now().toISOString();
        const next: Supplier = {
          ...supplier!,
          revision: revision + 1,
          confirmationHours: request.confirmationHours,
          link: request.link
            ? {
                ...request.link,
                name,
                linkedBy: context.actor.id,
                linkedAt: now,
              }
            : null,
        };
        await tx.updateSupplier(next);
        await tx.audit({
          ...audit(
            context,
            'supplier.updated',
            `${supplierId}:${next.revision}`,
            supplierId,
            {
              supplierId,
              revision: String(next.revision),
              connectionId: request.link?.connectionId ?? '',
              externalId: request.link?.externalId ?? '',
              confirmationHours: String(request.confirmationHours),
            },
          ),
          correlationId: supplierId,
          proposalId: supplierId,
        });

        return next;
      });
    },
    /** Reads an order with its supplier lifecycle, evidence and what a person can do next. */
    async order(context: TenantContext, orderId: string) {
      context = await authorize(context);
      const data = await record(context, orderId);
      const verifiedRuns = await verified(context, [data.order]);
      const { progress, submission } = progressFor(data.order, {
        ...data,
        verified: verifiedRuns,
      });
      const canManage = hasPermission(context, 'procurement.manage');

      const { timelineEntries, ...recordData } = data;
      const timeline = purchasingTimeline({
        ...recordData,
        extra: [
          ...timelineEntries,
          ...((await deps.additionalTimeline?.(context, orderId)) ?? []),
        ],
      });

      if (deps.timelineActors)
        timeline.entries = await deps.timelineActors(
          context,
          timeline.entries,
          data.order.origin.workflowRunId,
        );

      return {
        ...recordData,
        value: orderValue(data.order),
        timeline,
        submission: submission
          ? await submissionView(context, submission)
          : null,
        progress,
        stage: orderStage(data.order, submission, progress),
        draftVerified:
          !!data.order.origin.workflowRunId &&
          verifiedRuns.has(data.order.origin.workflowRunId),
        canManage,
        reconciliation: {
          available: (await deps.reconciliationAvailable?.(context)) ?? false,
          decisions: (await deps.shortfallAvailable?.(context)) ?? false,
          manualReceipt:
            data.order.authority === 'luma' &&
            data.order.status === 'open' &&
            !data.supplier?.link &&
            !data.submissions.some((s) => s.channel !== 'email'),
        },
        extraction: {
          available: deps.model.available && !!deps.model.gateway,
          reason: deps.model.available ? null : deps.model.reason,
        },
      };
    },
    /** Summarizes every order's stage, expected date and open attention for lists. */
    async summaries(context: TenantContext) {
      context = await authorize(context);
      const now = deps.now();

      return [
        ...(
          await deps.store.transaction(context.tenantId, false, async (tx) =>
            summarize(tx, await tx.orders(), now),
          )
        ).values(),
      ];
    },
    /**
     * Lists one page of purchase orders, or every group's first rows with `group`. Stage,
     * attention, next owner and the progress dates follow the same progress rules as the order
     * record, evaluated at the first page's time so later pages do not shift; conditions,
     * groups and sorts on them read every order that matches the stored conditions before
     * paging. An unfiltered first page also counts every order in the workspace per stage and
     * needing attention. Conditions and the sort may name readable custom purchase-order
     * fields, which filter and order in SQL before paging. Throws a 400 error for invalid
     * conditions, groups, cursors issued for another query and archived or unknown custom
     * fields, and a 403 error for custom fields the reader may not read.
     */
    async listOrders(
      context: TenantContext,
      query: PurchaseOrderListQuery,
    ): Promise<PurchaseOrderList> {
      context = await authorize(context);
      const { tenantId } = context;
      const direction = purchaseOrderDirection(query);
      const group = query.group
        ? purchaseOrderGroupField(query.group.field, query.group.granularity)
        : null;
      if (query.groupKey !== undefined && !group)
        throw listQueryError('Choose a grouping to read one group.');
      const grouped = !!group && query.groupKey === undefined;
      if (grouped && query.cursor)
        throw listQueryError(
          'Use a group’s page link together with its group key.',
        );
      const timeZone = listTimeZone(query.timeZone);
      // Page sizes are not part of the scope, so a group's later pages may use another size.
      const scopeFor = (groupKey: ListGroupKey | undefined) =>
        listScope(deps.digest, 'purchase-orders-v2', tenantId, {
          q: query.q,
          supplierId: query.supplierId ?? null,
          status: query.status ?? null,
          stage: query.stage ?? null,
          where: query.where ?? null,
          group: query.group ?? null,
          groupKey: groupKey === undefined ? null : { key: groupKey },
          timeZone,
          sort: query.sort,
          direction,
        });
      const scope = scopeFor(query.groupKey);
      const cursor = query.cursor
        ? readListCursor(query.cursor, scope, 'purchase order', true)
        : null;
      const asOf = cursor?.asOf ?? deps.now().toISOString();
      const now = new Date(asOf);
      const after: ListPosition | null = cursor
        ? { rank: cursor.rank, keys: cursor.keys, id: cursor.id }
        : null;
      const customIds = customFieldIds(query.where, query.sort);
      const where = withCustomReader(query.where, context.actor.id);
      const member =
        group && query.groupKey !== undefined
          ? groupMember(group, query.groupKey)
          : null;
      const storedSort = isStoredSort(query.sort) ? query.sort : null;
      const exact = query.count === 'exact' || !!member;
      const unfiltered =
        !cursor &&
        !query.q &&
        !query.stage &&
        !query.supplierId &&
        !query.status &&
        !query.where?.conditions.length &&
        !group;
      const read = await deps.store.transaction(tenantId, false, async (tx) => {
        // Custom field definitions come from the snapshot whose values they filter.
        let custom: ListCustomField[] = [];
        if (customIds.length) {
          if (!tx.customFields)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Custom fields are unavailable.',
            );
          custom = readableCustomFields(
            context,
            customIds,
            await tx.customFields('purchase_order', customIds),
          );
          customSortField(custom, query.sort);
        }
        const plan = planListWhere(
          where,
          {
            ...purchaseOrderFields,
            ...customListFields<PurchaseOrderRow>(custom),
          },
          { now, timeZone },
        );
        const filter: PurchaseOrderFilter = {
          q: query.q,
          supplierId: query.supplierId,
          status: query.status,
          conditions: plan.stored ?? undefined,
          customFields: custom,
        };
        // Derived values decide matches, groups or order, so those queries read every match.
        const derived =
          !!plan.memory || query.stage !== undefined || !!group || !storedSort;
        const rows = await tx.purchaseOrders(
          filter,
          storedSort ? { sort: storedSort, direction, after } : null,
          derived ? null : query.limit + 1,
        );
        // Stored sorts read the rows after the cursor in SQL order; counting needs them all.
        const every =
          derived && exact && after && storedSort
            ? await tx.purchaseOrders(filter, null, null)
            : null;
        const total =
          query.count === 'exact' && !derived
            ? await tx.countPurchaseOrders(filter)
            : null;
        // Workspace counts come with an unfiltered first page, such as the page overview.
        const all = unfiltered ? await tx.orders() : null;
        const orders = new Map(
          [
            ...(all ?? []),
            ...[...rows, ...(every ?? [])].map((row) => row.record),
          ].map((order) => [order.id, order]),
        );
        const summaries = await summarize(
          tx,
          [...orders.values()],
          now,
          all ? undefined : [...orders.keys()],
        );

        return {
          rows,
          every,
          total,
          all,
          summaries,
          memory: plan.memory,
          derived,
        };
      });
      const { summaries, memory, derived } = read;
      const compareKeys = derivedKeyComparator(query.sort);
      const matching = (rows: Positioned<PurchaseOrder>[]) => {
        const list = rows
          .map((row): PositionedRow => {
            const summary = summaries.get(row.record.id)!;
            const record = { order: row.record, summary };

            return {
              ...record,
              position: isStoredSort(query.sort)
                ? row.position
                : derivedPosition(record, query.sort),
            };
          })
          .filter(
            (row) =>
              inStage(row.summary, query.stage) &&
              (memory?.(row) ?? true) &&
              (member?.(row) ?? true),
          );

        return storedSort
          ? list
          : list.sort((a, b) =>
              comparePositions(a.position, b.position, direction, compareKeys),
            );
      };
      const matched = matching(read.rows);
      const rows =
        !storedSort && after
          ? matched.filter(
              (row) =>
                comparePositions(row.position, after, direction, compareKeys) >
                0,
            )
          : matched;
      const item = (row: PurchaseOrderRow) => ({
        ...row.order,
        summary: row.summary,
      });
      const canManage = hasPermission(context, 'procurement.manage');
      if (group && grouped) {
        const result = groupPurchaseOrders(
          rows,
          group,
          Math.min(Math.max(query.groupLimit ?? 10, 1), 50),
          (key, last) => writeListCursor(scopeFor(key), last, asOf),
        );

        return {
          items: result.items.map(item),
          canManage,
          totalCount: query.count === 'exact' ? rows.length : null,
          counts: null,
          nextCursor: null,
          groups: result.groups,
          groupsTruncated: result.truncated,
          asOf,
        };
      }
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last
          ? writeListCursor(scope, last.position, asOf)
          : null;
      const totalCount =
        read.total ??
        (exact && derived
          ? read.every
            ? matching(read.every).length
            : matched.length
          : null);
      let counts: PurchaseOrderList['counts'] = null;
      if (read.all) {
        const stages: Partial<Record<OrderStage, number>> = {};
        let attention = 0;
        for (const order of read.all) {
          const summary = summaries.get(order.id)!;
          stages[summary.stage] = (stages[summary.stage] ?? 0) + 1;
          if (summary.attention > 0) attention++;
        }
        counts = { all: read.all.length, attention, stages };
      }

      return {
        items: page.map(item),
        canManage,
        totalCount,
        counts,
        nextCursor,
        ...(member
          ? {
              groups: [
                {
                  key: query.groupKey ?? null,
                  count: totalCount ?? 0,
                  complete: true,
                  itemIds: page.map((row) => row.order.id),
                  nextCursor,
                  sums: [],
                },
              ],
            }
          : {}),
        asOf,
      };
    },
    /**
     * Suppliers with at least one order whose progress has an open `confirmation_overdue` item
     * at the read time. Only orders with a verified submission can have one, so only those
     * are summarized.
     */
    async confirmationOverdueSuppliers(context: TenantContext) {
      context = await authorize(context);
      const now = deps.now();

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const ids = [
          ...new Set(
            (await tx.submissions())
              .filter((submission) => submission.state === 'submitted')
              .map((submission) => submission.purchaseOrderId),
          ),
        ];
        if (!ids.length) return [];
        const orders = (await tx.purchaseOrders({ q: '', ids }, null, null))
          .map((row) => row.record)
          .filter((order) => order.status !== 'cancelled');
        const summaries = await summarize(
          tx,
          orders,
          now,
          orders.map((order) => order.id),
        );

        return [
          ...new Set(
            orders
              .filter((order) =>
                summaries
                  .get(order.id)
                  ?.attentionKinds.includes('confirmation_overdue'),
              )
              .map((order) => order.supplierId),
          ),
        ];
      });
    },
    /**
     * Lists attention across open orders for Needs you, from persisted state only. `filter`
     * narrows the orders by supplier and status and the attention by kind.
     */
    async pending(
      context: TenantContext,
      filter: {
        supplierId?: string | undefined;
        status?: PurchaseOrder['status'] | undefined;
        /** Only attention of these kinds. */
        kinds?: Attention['kind'][] | undefined;
      } = {},
    ) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const submissions = await tx.submissions();
          const commitments = await tx.commitments();
          const orderIds = new Set([
            ...submissions
              .filter(
                (s) =>
                  !['rejected', 'expired', 'failed', 'not_executed'].includes(
                    s.state,
                  ),
              )
              .map((s) => s.purchaseOrderId),
            ...commitments.map((c) => c.purchaseOrderId),
          ]);
          const found = new Map(
            (
              await tx.purchaseOrders(
                {
                  q: '',
                  supplierId: filter.supplierId,
                  status: filter.status,
                  ids: [...orderIds],
                },
                null,
                null,
              )
            ).map((row) => [row.record.id, row.record]),
          );
          const orders = [...orderIds]
            .map((id) => found.get(id))
            .filter(
              (o): o is PurchaseOrder =>
                !!o && !['closed', 'cancelled'].includes(o.status),
            );

          return {
            orders,
            submissions,
            commitments,
            followUps: await tx.followUps(orders.map((o) => o.id)),
            suppliers: new Map(
              await Promise.all(
                [...new Set(orders.map((o) => o.supplierId))].map(
                  async (id) => [id, await tx.supplier(id)] as const,
                ),
              ),
            ),
          };
        },
      );
      const items: {
        attention: Attention;
        order: PurchaseOrder;
        supplierName: string;
        submission: SubmissionView | null;
        commitment: Commitment | null;
        line: PurchaseOrder['lines'][number] | null;
        canRespond: boolean;
      }[] = [];
      for (const order of data.orders) {
        const { progress, submission } = progressFor(order, {
          ...data,
          supplier: data.suppliers.get(order.supplierId) ?? null,
          verified: new Set(),
        });
        const wanted = progress.attention.filter(
          (attention) => !filter.kinds || filter.kinds.includes(attention.kind),
        );
        if (!wanted.length) continue;
        const view = submission
          ? await submissionView(context, submission)
          : null;
        for (const attention of wanted) {
          if (
            attention.kind === 'submission_approval' &&
            view?.state === 'expired'
          )
            continue;
          items.push({
            attention,
            order,
            supplierName: order.supplierName,
            submission: view,
            commitment:
              data.commitments.find((c) => c.id === attention.commitmentId) ??
              null,
            line: order.lines.find((l) => l.id === attention.lineId) ?? null,
            canRespond:
              attention.kind === 'submission_approval'
                ? !!view?.canApprove
                : attention.kind === 'submission_uncertain'
                  ? !!view?.canCheck
                  : hasPermission(context, 'procurement.manage'),
          });
        }
      }

      return items;
    },
    /** Reads a supplier with its orders, open attention and recent messages. */
    async supplier(context: TenantContext, supplierId: string) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const supplier = await tx.supplier(supplierId);
          if (!supplier) notFound('Supplier not found');
          const orders = (await tx.orders()).filter(
            (o) => o.supplierId === supplierId,
          );
          const ids = orders.map((o) => o.id);

          return {
            supplier: supplier!,
            orders,
            submissions: ids.length ? await tx.submissions(ids) : [],
            commitments: ids.length ? await tx.commitments(ids) : [],
            followUps: ids.length ? await tx.followUps(ids) : [],
            communications: (await tx.communications({ supplierId })).slice(
              0,
              20,
            ),
          };
        },
      );
      const verifiedRuns = await verified(context, data.orders);
      const connection =
        data.supplier.link && deps.purchasing
          ? ((
              await deps.purchasing
                .connections(context)
                .catch(() => [] as PurchasingConnection[])
            ).find((c) => c.id === data.supplier.link!.connectionId) ?? null)
          : null;

      return {
        supplier: data.supplier,
        connection,
        confirmationHours: terms(data.supplier).confirmationHours,
        canManage: hasPermission(context, 'procurement.manage'),
        communications: data.communications,
        orders: data.orders.map((order) => {
          const { progress, submission } = progressFor(order, {
            ...data,
            supplier: data.supplier,
            verified: verifiedRuns,
          });

          return {
            order,
            stage: orderStage(order, submission, progress),
            progress,
            externalOrderNumber: submission?.externalOrder?.orderNumber ?? null,
          };
        }),
      };
    },
    /**
     * Requests approval to place an order in the supplier's purchasing system. The request ID
     * identifies the submission; an exact retry returns it.
     */
    async requestSubmission(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.submission(input);
      const today = deps.now().toISOString().slice(0, 10);
      if (request.requestedDeliveryDate < today)
        conflict('Choose a delivery date that is today or later.');
      const existing = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.submission(request.id),
      );
      if (existing) {
        if (
          existing.purchaseOrderId !== orderId ||
          existing.requestedBy !== context.actor.id ||
          existing.requestedDeliveryDate !== request.requestedDeliveryDate
        )
          conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return submissionView(context, existing);
      }
      if (!deps.admission)
        unavailable('Sending orders is unavailable on this server.');
      const prepared = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const order = await tx.order(orderId);
          if (!order) notFound('Purchase order not found');
          const supplier = await tx.supplier(order!.supplierId);
          const ready = await readiness(context, tx, order!, supplier);
          if (!ready.ready) conflict(ready.blockers[0]!);
          const live = (await tx.submissions([orderId])).find(
            (s) =>
              !['rejected', 'expired', 'failed', 'not_executed'].includes(
                s.state,
              ),
          );
          if (
            live &&
            !(
              live.state === 'approval_required' &&
              Date.parse(live.expiresAt) <= deps.now().getTime()
            )
          )
            conflict('This order already has a submission in progress.');
          if (live) await saveSubmission(tx, live, { state: 'expired' });
          const link = supplier!.link!;
          const mapping = await lineMapping(tx, order!, link.connectionId);
          const now = deps.now();
          const expiresAt = new Date(now.getTime() + 24 * hour).toISOString();
          const submission: Submission = {
            id: request.id,
            tenantId: context.tenantId,
            purchaseOrderId: orderId,
            connectionId: link.connectionId,
            supplier: { externalId: link.externalId, scopeKey: link.scopeKey },
            requestedDeliveryDate: request.requestedDeliveryDate,
            lines: mapping.map((m) => ({
              lineId: m.line.id,
              sku: m.sku!,
              quantity: m.line.quantity,
              unit: m.line.unit,
            })),
            actionId: deps.uuid(`submission-action:${request.id}`),
            decisionId: null,
            requestedBy: context.actor.id,
            requestedAt: now.toISOString(),
            expiresAt,
            state: 'approval_required',
            externalOrder: null,
            submittedAt: null,
            decidedBy: null,
            decidedAt: null,
            failure: null,
            updatedAt: now.toISOString(),
          };
          await tx.insertSubmission(submission);
          await tx.audit(
            audit(
              context,
              'purchase_order.submission_requested',
              request.id,
              orderId,
              {
                submissionId: request.id,
                connectionId: link.connectionId,
                requestedDeliveryDate: request.requestedDeliveryDate,
              },
            ),
          );

          return { submission, order: order! };
        },
      );
      const action = submissionAction(prepared.submission, prepared.order);
      let decision: PolicyDecision;
      try {
        decision = await deps.admission!.prepare(
          context,
          prepared.submission,
          action,
        );
      } catch {
        await deps.store.transaction(context.tenantId, true, async (tx) =>
          saveSubmission(tx, prepared.submission, {
            state: 'failed',
            failure: 'Approval could not be requested. Nothing was sent.',
          }),
        );
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Approval could not be requested. Nothing was sent. Try again.',
        );
      }
      const saved = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) =>
          saveSubmission(tx, prepared.submission, {
            decisionId: decision.id,
            ...(decision.outcome === 'denied'
              ? {
                  state: 'failed' as const,
                  failure:
                    'The purchasing system or policy no longer allows this order. Nothing was sent.',
                }
              : decision.outcome === 'allowed'
                ? { state: 'approved' as const }
                : {}),
          }),
      );
      if (
        saved.state === 'approved' ||
        (await deps.admission?.writeMode?.(context, saved.connectionId)) ===
          'observe_only'
      )
        await dispatch(context, saved);

      return submissionView(
        context,
        (await deps.store.transaction(context.tenantId, false, (tx) =>
          tx.submission(saved.id),
        ))!,
      );
    },
    /**
     * Approves or rejects a submission. Approval comes from someone other than the requester who
     * can manage procurement; Luma then dispatches it as the requester, exactly once.
     */
    async decideSubmission(
      context: TenantContext,
      submissionId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.decision(input);
      if (!deps.admission)
        unavailable('Sending orders is unavailable on this server.');
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.submission(submissionId),
      );
      if (!submission) notFound('Submission not found');
      if (submission!.channel === 'email')
        conflict(
          'Review and send this supplier email in the Operations Inbox.',
        );
      const view = await submissionView(context, submission!);
      if (!view.canApprove || submission!.decisionId !== request.decisionId)
        conflict(
          'This request changed, expired or needs a different approver. Refresh it.',
        );
      await deps.admission!.respond(
        context,
        request.decisionId,
        request.outcome,
        submission!.expiresAt,
      );
      const decided = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const saved = await saveSubmission(tx, submission!, {
            state: request.outcome === 'approved' ? 'approved' : 'rejected',
            decidedBy: context.actor.id,
            decidedAt: deps.now().toISOString(),
          });
          await tx.audit(
            audit(
              context,
              `purchase_order.submission_${request.outcome}`,
              submissionId,
              saved.purchaseOrderId,
              { submissionId, decisionId: request.decisionId },
            ),
          );

          return saved;
        },
      );
      if (decided.state === 'approved') {
        // The approval does not grant the approver execution authority; the requester's
        // current membership is resolved and checked again by admission.
        try {
          const principal = await deps.principal(
            decided.requestedBy,
            context.tenantId,
            `submission:${submissionId}`,
          );
          await dispatch(principal, decided);
        } catch {
          // The monitor retries approved submissions; the requester can also send it.
        }
      }

      return submissionView(
        context,
        (await deps.store.transaction(context.tenantId, false, (tx) =>
          tx.submission(submissionId),
        ))!,
      );
    },
    /** Sends an approved submission now. Only the requester can dispatch it. */
    async sendSubmission(context: TenantContext, submissionId: string) {
      context = await authorize(context, true);
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.submission(submissionId),
      );
      if (!submission) notFound('Submission not found');
      if (submission!.channel === 'email')
        conflict(
          'Review and send this supplier email in the Operations Inbox.',
        );
      if (
        context.actor.id === submission!.requestedBy &&
        [
          'submitted',
          'failed',
          'rejected',
          'expired',
          'uncertain',
          'submitting',
        ].includes(submission!.state)
      )
        return submissionView(context, submission!);
      const view = await submissionView(context, submission!);
      if (!view.canSend)
        conflict('Only the requester can send an approved submission.');
      await dispatch(context, submission!);

      return submissionView(
        context,
        (await deps.store.transaction(context.tenantId, false, (tx) =>
          tx.submission(submissionId),
        ))!,
      );
    },
    /** Rechecks an uncertain submission by reading the purchasing system; never resends. */
    async checkSubmission(context: TenantContext, submissionId: string) {
      context = await authorize(context, true);
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.submission(submissionId),
      );
      if (!submission) notFound('Submission not found');
      if (!deps.admission)
        unavailable('Sending orders is unavailable on this server.');
      if (submission!.channel === 'email')
        conflict('Check the existing supplier email in the Operations Inbox.');
      if (!['uncertain', 'submitting'].includes(submission!.state))
        return submissionView(context, submission!);
      const principal = await deps
        .principal(
          submission!.requestedBy,
          context.tenantId,
          `submission-check:${submissionId}`,
        )
        .catch((error: unknown) => {
          if (error instanceof MembershipSuspendedError)
            conflict(
              'The person who requested this order can’t access this workspace right now. Luma checks it after their access is restored.',
            );
          throw error;
        });
      const execution = await deps.admission!.reconcile(principal, submission!);
      await settle(principal, submissionId, execution);

      return submissionView(
        context,
        (await deps.store.transaction(context.tenantId, false, (tx) =>
          tx.submission(submissionId),
        ))!,
      );
    },
    /** Reads the purchasing-system order now and records new confirmations and receipts. */
    async refresh(context: TenantContext, orderId: string) {
      context = await authorize(context);
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) =>
          (await tx.submissions([orderId])).find(
            (s) => s.state === 'submitted',
          ) ?? null,
      );
      if (!submission?.externalOrder)
        conflict('This order has not been placed in a purchasing system.');
      const found = await locate(context, submission!);
      if (!found)
        unavailable(
          'The purchasing system could not be read. The details below may be out of date.',
        );
      await observe(context, submission!, found!);

      return service.order(context, orderId);
    },
    /**
     * Captures a supplier message for an order and reads its commitments when a model is
     * configured. Repeated deliveries of the same message are recorded once.
     */
    async recordMessage(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.message(input);
      const key = request.messageId
        ? `id:${request.messageId}`
        : `digest:${deps.digest({ from: request.from.toLowerCase(), subject: request.subject, receivedAt: request.receivedAt, body: request.body })}`;
      const { communication, order, created } = await command(
        context,
        request.id,
        { kind: 'message', orderId, ...request },
        async (tx) => {
          const order = await tx.order(orderId);
          if (!order) notFound('Purchase order not found');
          const duplicate = await tx.communicationByKey(key);
          if (duplicate)
            return { communication: duplicate, order: order!, created: false };
          const now = deps.now();
          const communication: Communication = {
            id: request.id,
            tenantId: context.tenantId,
            supplierId: order!.supplierId,
            purchaseOrderId: orderId,
            channel: request.channel,
            from: request.from,
            subject: request.subject,
            body: request.body,
            receivedAt: request.receivedAt,
            messageId: request.messageId,
            digest: deps.digest(messageText(request)),
            capturedBy: context.actor.id,
            capturedAt: now.toISOString(),
            retainUntil: new Date(
              Date.parse(request.receivedAt) + deps.retentionDays * 24 * hour,
            ).toISOString(),
          };
          await tx.insertCommunication(communication, key);
          await tx.audit(
            audit(
              context,
              'purchase_order.message_recorded',
              request.id,
              orderId,
              {
                communicationId: request.id,
                channel: request.channel,
              },
            ),
          );

          return { communication, order: order!, created: true };
        },
      );
      if (
        created ||
        !(
          await deps.store.transaction(context.tenantId, false, (tx) =>
            tx.extractions([communication.id]),
          )
        ).length
      )
        await extractInto(context, communication, order, 1);

      return { communicationId: communication.id, duplicate: !created };
    },
    /** Reads a message again after an unavailable or failed attempt. */
    async extractAgain(context: TenantContext, communicationId: string) {
      context = await authorize(context, true);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const communication = await tx.communication(communicationId);
          if (!communication?.purchaseOrderId) notFound('Message not found');

          return {
            communication: communication!,
            order: (await tx.order(communication!.purchaseOrderId!))!,
            attempts: await tx.extractions([communicationId]),
          };
        },
      );
      if (data.attempts.some((a) => a.state === 'completed'))
        conflict('This message was already read. Record corrections by hand.');
      if (!data.communication.body)
        conflict('The message text was removed and cannot be read again.');

      return extractInto(
        context,
        data.communication,
        data.order,
        data.attempts.length + 1,
      );
    },
    /** Removes a message's text on request, keeping its metadata and commitments. */
    async removeMessageText(context: TenantContext, communicationId: string) {
      context = await authorize(context, true);

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const communication = await tx.communication(communicationId);
        if (!communication) notFound('Message not found');
        if (communication!.purgedAt) return communication!;
        const purged: Communication = {
          ...communication!,
          subject: null,
          body: null,
          purgedAt: deps.now().toISOString(),
          purgeReason: 'request',
        };
        await tx.purgeCommunication(purged);
        await tx.audit(
          audit(
            context,
            'purchase_order.message_removed',
            communicationId,
            communication!.purchaseOrderId ?? communication!.supplierId,
            { communicationId },
          ),
        );

        return purged;
      });
    },
    /** Returns the current bounded remainder for an active decision; proposals must recheck it before effects. */
    async shortfall(
      context: TenantContext,
      orderId: string,
      attentionKey: string,
    ) {
      context = await authorize(context);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const order = await tx.order(orderId);
        if (!order) notFound('Purchase order not found');
        const commitments = await tx.commitments([orderId]);
        const { progress } = progressFor(order!, {
          submissions: await tx.submissions([orderId]),
          commitments,
          followUps: await tx.followUps([orderId]),
          supplier: await tx.supplier(order!.supplierId),
          verified: new Set(),
        });
        const attention = progress.attention.find(
          (a) => a.key === attentionKey,
        );
        if (
          !attention ||
          !['commitment_changed', 'receipt_difference'].includes(attention.kind)
        )
          conflict(
            'This difference no longer needs a decision. Refresh the order.',
          );
        const fact = commitments.find((c) => c.id === attention!.commitmentId);
        const affected = attention!.lineId
          ? progress.lines.filter((line) => line.lineId === attention!.lineId)
          : progress.lines;

        return {
          supplierId: order!.supplierId,
          quantities: affected
            .map((line) => ({
              sku: line.sku,
              lineId: line.lineId,
              quantity:
                fact?.kind === 'confirmed_quantity'
                  ? Math.max(0, line.ordered - (fact.quantity ?? line.ordered))
                  : fact?.kind === 'shortage' || fact?.kind === 'damaged'
                    ? (fact.quantity ?? 0)
                    : line.outstanding,
            }))
            .filter((line) => line.quantity > 0),
          evidenceRefs: [orderId, ...(fact ? [fact.id] : [])],
        };
      });
    },
    /** Records cumulative manual receipts or differences without changing provider evidence. */
    async recordReceipt(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      if (
        !deps.parse.receipt ||
        !(await deps.reconciliationAvailable?.(context))
      )
        unavailable(
          'Receipt reconciliation is not enabled for this workspace.',
        );
      const request = deps.parse.receipt!(input);

      return incomingResult(
        context,
        orderId,
        command(
          context,
          request.id,
          { command: 'receipt', orderId, ...request },
          async (tx) => {
            const order = await tx.order(orderId);
            if (!order) notFound('Purchase order not found');
            if (order!.authority !== 'luma' || order!.status !== 'open')
              conflict('Only an open Luma purchase order can be reconciled.');
            if (!order!.lines.some((line) => line.id === request.lineId))
              conflict('That order line does not exist.');
            if (Date.parse(request.receivedAt) > deps.now().getTime())
              conflict('Receipt time cannot be in the future.');
            const supplier = await tx.supplier(order!.supplierId);
            const submissions = await tx.submissions([orderId]);
            if (
              request.kind === 'received' &&
              (supplier?.link || submissions.some((s) => s.channel !== 'email'))
            )
              conflict(
                'Record receipt in the purchasing system that owns this order.',
              );
            const commitments = await tx.commitments([orderId]);
            const latest = commitments
              .filter(
                (c) =>
                  c.lineId === request.lineId &&
                  c.kind === request.kind &&
                  c.status === 'confirmed',
              )
              .at(-1);
            if ((latest?.id ?? null) !== request.expectedCommitmentId)
              conflict(
                'This quantity changed. Refresh the order before recording it.',
              );
            const receipt = commitments
              .filter(
                (c) =>
                  c.lineId === request.lineId &&
                  c.kind === 'received' &&
                  c.status === 'confirmed',
              )
              .at(-1);
            const damaged = commitments
              .filter(
                (c) =>
                  c.lineId === request.lineId &&
                  c.kind === 'damaged' &&
                  c.status === 'confirmed',
              )
              .at(-1);
            if (
              request.kind === 'received' &&
              request.damagedQuantity !== undefined &&
              (damaged?.id ?? null) !== request.expectedDamagedCommitmentId
            )
              conflict(
                'Damaged quantities changed. Refresh the order before recording receipt.',
              );
            if (
              request.kind === 'damaged' &&
              request.quantity > (receipt?.quantity ?? 0)
            )
              conflict('Damaged units cannot exceed the recorded receipt.');
            if (
              request.kind === 'received' &&
              request.damagedQuantity !== undefined &&
              request.damagedQuantity > request.quantity
            )
              conflict('Damaged units cannot exceed the receipt.');
            if (
              request.kind === 'received' &&
              request.quantity <
                (request.damagedQuantity ?? damaged?.quantity ?? 0)
            )
              conflict(
                'Receipt cannot be less than the recorded damaged units.',
              );
            const commitment = await tx.insertCommitment(
              {
                id: request.id,
                tenantId: context.tenantId,
                purchaseOrderId: orderId,
                lineId: request.lineId,
                kind: request.kind,
                quantity: request.quantity,
                date: null,
                text: null,
                source: {
                  kind: 'manual_receipt',
                  receivedAt: request.receivedAt,
                  condition: request.condition,
                  reason: request.reason,
                  evidence: request.evidence,
                },
                status: 'confirmed',
                reviewReasons: [],
                supersedes: latest?.id ?? null,
                recordedAt: deps.now().toISOString(),
                recordedBy: { kind: 'user', id: context.actor.id },
                review: null,
              },
              `receipt:${request.id}`,
            );
            if (
              request.kind === 'received' &&
              request.damagedQuantity !== undefined
            )
              await tx.insertCommitment(
                {
                  ...commitment,
                  id: deps.uuid(`receipt-damage:${request.id}`),
                  kind: 'damaged',
                  quantity: request.damagedQuantity,
                  supersedes: damaged?.id ?? null,
                },
                `receipt-damage:${request.id}`,
              );
            await tx.audit(
              audit(
                context,
                'purchase_order.receipt_recorded',
                request.id,
                orderId,
                {
                  commitmentId: request.id,
                  kind: request.kind,
                  quantity: String(request.quantity),
                  lineId: request.lineId,
                  reason: request.reason,
                },
                request.evidence,
              ),
            );

            return commitment;
          },
        ),
      );
    },
    /** Records the independently verified result of an admitted Operations Inbox submission. */
    async recordEmailSubmission(
      context: TenantContext,
      request: {
        id: string;
        purchaseOrderId: string;
        outboundId: string;
        threadId: string;
        connectionId: string;
        requestedDeliveryDate: string;
        state: 'submitted' | 'failed' | 'uncertain';
        sentMessageId?: string;
        reason?: string;
      },
    ) {
      context = await authorize(context, true);
      const result = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const order = await tx.order(request.purchaseOrderId);
          if (!order) notFound('Purchase order not found');
          const supplier = await tx.supplier(order!.supplierId);
          const prior = await tx.submission(request.id);
          if (
            !prior &&
            (supplier?.link ||
              order!.authority !== 'luma' ||
              !['draft', 'open'].includes(order!.status))
          )
            conflict('This order cannot be sent through email.');
          if (
            prior &&
            (prior.channel !== 'email' ||
              prior.purchaseOrderId !== request.purchaseOrderId ||
              prior.outgoing?.outboundId !== request.outboundId ||
              prior.requestedBy !== context.actor.id)
          )
            conflict('This email submission ID was already used.');
          if (prior?.state === 'submitted' && request.state === 'submitted')
            return { submission: prior, order: order! };
          if (
            !prior &&
            (await tx.submissions([order!.id])).some(
              (s) => !['failed', 'rejected', 'expired'].includes(s.state),
            )
          )
            conflict('An active submission already exists for this order.');
          const now = deps.now().toISOString();
          const submission: Submission = {
            id: request.id,
            tenantId: context.tenantId,
            purchaseOrderId: order!.id,
            channel: 'email',
            outgoing: {
              outboundId: request.outboundId,
              threadId: request.threadId,
              sentMessageId: request.sentMessageId ?? null,
            },
            connectionId: request.connectionId,
            supplier: { externalId: order!.supplierId, scopeKey: '' },
            requestedDeliveryDate:
              prior?.requestedDeliveryDate ?? request.requestedDeliveryDate,
            lines: order!.lines.map((line) => ({
              lineId: line.id,
              sku: { externalId: line.sku, scopeKey: '' },
              quantity: line.quantity,
              unit: line.unit,
            })),
            actionId: request.outboundId,
            decisionId: null,
            requestedBy: context.actor.id,
            requestedAt: prior?.requestedAt ?? now,
            expiresAt: prior?.expiresAt ?? now,
            state: request.state,
            externalOrder: null,
            submittedAt:
              prior?.submittedAt ??
              (request.state === 'submitted' ? now : null),
            decidedBy: null,
            decidedAt: null,
            failure: request.reason ?? null,
            updatedAt: now,
          };
          if (prior) await tx.saveSubmission(submission, true);
          else {
            await tx.insertSubmission(submission);
            await tx.saveSubmission(submission, true);
          }
          await tx.audit(
            audit(
              context,
              'purchase_order.email_submission',
              `${request.id}:${request.state}`,
              order!.id,
              {
                state: request.state,
                outboundId: request.outboundId,
                threadId: request.threadId,
              },
              [request.outboundId],
            ),
          );

          return { submission, order: order! };
        },
      );
      if (request.state === 'submitted' && result.order.status === 'draft')
        await deps.openOrder(
          context,
          result.order,
          deps.uuid(`email-open:${request.id}`),
          'Approved email submission verified by the mail provider',
        );

      await deps.incomingChanged?.(context, request.purchaseOrderId);

      return result.submission;
    },
    /** Records what a supplier said by hand, citing a message, or corrects a commitment. */
    async recordCommitment(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.commitment(input);

      return incomingResult(
        context,
        orderId,
        command(
          context,
          request.id,
          { command: 'commitment', orderId, ...request },
          async (tx) => {
            const order = await tx.order(orderId);
            if (!order) notFound('Purchase order not found');
            const line = request.lineId
              ? order!.lines.find((l) => l.id === request.lineId)
              : null;
            if (request.lineId && !line)
              conflict('That order line does not exist.');
            if (
              request.kind === 'confirmed_quantity' &&
              (!line || request.quantity === null)
            )
              conflict('A confirmed quantity needs a line and a quantity.');
            if (request.kind === 'promised_date' && !request.date)
              conflict('A promised date needs a date.');
            if (request.kind === 'condition' && !request.text?.trim())
              conflict('Describe the condition.');
            let source: Commitment['source'];
            if (request.supersedes) {
              const prior = await tx.commitment(request.supersedes);
              if (!prior || prior.purchaseOrderId !== orderId)
                notFound('The commitment to correct was not found.');
              if (prior!.kind === 'received')
                conflict(
                  'Receipts come from the purchasing system and cannot be corrected here.',
                );
              if (!request.reason?.trim()) conflict('Explain the correction.');
              source = { kind: 'correction', reason: request.reason!.trim() };
            } else {
              if (!request.communicationId || !request.span)
                conflict(
                  'Select the words in a supplier message that state this.',
                );
              const communication = await tx.communication(
                request.communicationId!,
              );
              if (!communication || communication.purchaseOrderId !== orderId)
                notFound('Message not found');
              if (!communication!.body && communication!.subject === null)
                conflict('The message text was removed.');
              const text = messageText({
                subject: communication!.subject ?? '',
                body: communication!.body ?? '',
              });
              if (
                request.span!.start < 0 ||
                request.span!.end > text.length ||
                request.span!.end <= request.span!.start
              )
                conflict('The selected words are not in the message.');
              source = {
                kind: 'communication',
                communicationId: communication!.id,
                span: request.span!,
                extraction: null,
              };
            }
            const now = deps.now().toISOString();
            const submission = (await tx.submissions([orderId]))[0] ?? null;
            const commitment = await tx.insertCommitment(
              {
                id: request.id,
                tenantId: context.tenantId,
                purchaseOrderId: orderId,
                lineId: request.lineId,
                kind: request.kind,
                quantity: ['confirmed_quantity', 'shipped'].includes(
                  request.kind,
                )
                  ? request.quantity
                  : null,
                date: ['promised_date', 'shipped'].includes(request.kind)
                  ? request.date
                  : null,
                text:
                  request.kind === 'condition' ? request.text!.trim() : null,
                source: source!,
                status: 'confirmed',
                reviewReasons: [],
                supersedes: request.supersedes,
                recordedAt: now,
                recordedBy: { kind: 'user', id: context.actor.id },
                review: null,
              },
              `manual:${request.id}`,
            );
            // A person who records a change has seen it; record that they accepted it.
            if (
              isMaterialChange(
                commitment,
                line ?? undefined,
                submission?.requestedDeliveryDate ?? null,
              )
            )
              await tx.insertFollowUp({
                id: deps.uuid(`follow-up:commitment_changed:${commitment.id}`),
                tenantId: context.tenantId,
                purchaseOrderId: orderId,
                key: `commitment_changed:${commitment.id}`,
                response: 'accepted',
                note: 'Recorded by hand',
                nextCheckAt: null,
                respondedBy: context.actor.id,
                respondedAt: now,
              });
            await tx.audit(
              audit(
                context,
                'purchase_order.commitment_recorded',
                request.id,
                orderId,
                {
                  commitmentId: request.id,
                  kind: request.kind,
                  lineId: request.lineId ?? '',
                  supersedes: request.supersedes ?? '',
                },
              ),
            );

            return commitment;
          },
        ),
      );
    },
    /** Confirms or rejects an extracted commitment; values are never edited. */
    async reviewCommitment(
      context: TenantContext,
      commitmentId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.review(input);

      const result = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const commitment = await tx.commitment(commitmentId);
          if (!commitment) notFound('Commitment not found');
          if (commitment!.status !== 'needs_review') {
            if (commitment!.review?.outcome === request.outcome)
              return commitment!;
            conflict('This commitment was already reviewed. Refresh it.');
          }
          const now = deps.now().toISOString();
          const reviewed: Commitment = {
            ...commitment!,
            status: request.outcome,
            review: { outcome: request.outcome, by: context.actor.id, at: now },
          };
          await tx.reviewCommitment(reviewed);
          if (request.outcome === 'confirmed' && request.acceptChange)
            await tx.insertFollowUp({
              id: deps.uuid(`follow-up:commitment_changed:${commitmentId}`),
              tenantId: context.tenantId,
              purchaseOrderId: commitment!.purchaseOrderId,
              key: `commitment_changed:${commitmentId}`,
              response: 'accepted',
              note: 'Accepted while reviewing the supplier message',
              nextCheckAt: null,
              respondedBy: context.actor.id,
              respondedAt: now,
            });
          await tx.audit(
            audit(
              context,
              'purchase_order.commitment_reviewed',
              commitmentId,
              commitment!.purchaseOrderId,
              { commitmentId, outcome: request.outcome },
            ),
          );

          return reviewed;
        },
      );
      await deps.incomingChanged?.(context, result.purchaseOrderId);

      return result;
    },
    /** Accepts a supplier change, or records a follow-up and when to check again. */
    async respond(context: TenantContext, orderId: string, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parse.followUp(input);

      return incomingResult(
        context,
        orderId,
        command(
          context,
          request.id,
          { command: 'follow_up', orderId, ...request },
          async (tx) => {
            const order = await tx.order(orderId);
            if (!order) notFound('Purchase order not found');
            if (
              (request.expectedOrderRevision !== undefined ||
                request.expectedScopeFingerprint !== undefined) &&
              (request.expectedOrderRevision !== order!.revision ||
                request.expectedScopeFingerprint !==
                  followUpScopeFingerprint(order!))
            )
              conflict(
                'The owned order changed after review. Refresh the proposal; the previous approval cannot authorize changed inputs.',
              );
            const current = {
              followUps: await tx.followUps([orderId]),
              progress: progressFor(order!, {
                submissions: await tx.submissions([orderId]),
                commitments: await tx.commitments([orderId]),
                followUps: await tx.followUps([orderId]),
                supplier: await tx.supplier(order!.supplierId),
                verified: new Set(),
              }).progress,
            };
            const attention = current.progress.attention.find(
              (a) => a.key === request.key,
            );
            if (!attention) {
              conflict('This no longer needs a response. Refresh the order.');
            }
            if (
              ![
                'commitment_changed',
                'confirmation_overdue',
                'delivery_overdue',
                'receipt_difference',
              ].includes(attention!.kind)
            )
              conflict('Respond to this from its own review.');
            if (
              request.response === 'accepted' &&
              !['commitment_changed', 'receipt_difference'].includes(
                attention!.kind,
              )
            )
              conflict('Record a follow-up and when to check again.');
            if (
              ['credited', 'written_off'].includes(request.response) &&
              attention!.kind !== 'receipt_difference'
            )
              conflict(
                'Only a received-goods difference can be credited or written off.',
              );
            const now = deps.now();
            if (request.response === 'following_up') {
              const next = request.nextCheckAt
                ? Date.parse(request.nextCheckAt)
                : NaN;
              if (
                !(next > now.getTime()) ||
                next > now.getTime() + 60 * 24 * hour
              )
                conflict(
                  'Choose when to check again, within the next 60 days.',
                );
            }
            const followUp: FollowUp = {
              id: request.id,
              tenantId: context.tenantId,
              purchaseOrderId: orderId,
              key: request.key,
              response: request.response,
              note: request.note.trim(),
              nextCheckAt:
                request.response === 'following_up'
                  ? request.nextCheckAt
                  : null,
              respondedBy: context.actor.id,
              respondedAt: now.toISOString(),
            };

            if (!(await tx.insertFollowUp(followUp)))
              conflict('Someone already responded. Refresh the order.');
            await tx.audit(
              audit(context, 'purchase_order.follow_up', request.id, orderId, {
                key: request.key,
                response: request.response,
                nextCheckAt: followUp.nextCheckAt ?? '',
                reason: followUp.note,
              }),
            );

            return followUp;
          },
        ),
      );
    },
    /**
     * Background step for one principal: dispatches approved submissions, settles uncertain
     * ones by reading, and reads placed orders for new confirmations and receipts.
     */
    async tick(context: TenantContext) {
      context = await authorize(context, true);
      const live = await deps.store.transaction(context.tenantId, false, (tx) =>
        tx.liveSubmissions(context.actor.id),
      );
      for (const submission of live) {
        if (submission.channel === 'email') {
          await deps.incomingChanged?.(context, submission.purchaseOrderId);
          continue;
        }
        if (submission.state === 'approved')
          await dispatch(context, submission);
        else if (
          (submission.state === 'uncertain' ||
            (submission.state === 'submitting' &&
              deps.now().getTime() - Date.parse(submission.updatedAt) >
                2 * 60_000)) &&
          deps.admission
        )
          await settle(
            context,
            submission.id,
            await deps.admission.reconcile(context, submission),
          );
        else if (submission.state === 'submitted') {
          const found = await locate(context, submission);
          if (found) await observe(context, submission, found);
        }
      }
    },
    /** Admission hook: the bound submission must still match the order, link and approval. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: unknown },
    ) {
      if (step.subject?.kind !== 'purchase_order_submission') return false;

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const submission = await tx.submission(step.subject!.id);
        if (
          !submission ||
          submission.actionId !== (step.action as { id?: string }).id ||
          !['approved', 'submitting', 'approval_required'].includes(
            submission.state,
          )
        )
          return false;
        const order = await tx.order(submission.purchaseOrderId);
        const supplier = order ? await tx.supplier(order.supplierId) : null;
        if (
          !order ||
          !supplier?.link ||
          !['draft', 'open'].includes(order.status) ||
          supplier.link.connectionId !== submission.connectionId ||
          supplier.link.externalId !== submission.supplier.externalId
        )
          return false;

        return (
          canonicalJson(submissionAction(submission, order)) ===
          canonicalJson(step.action)
        );
      });
    },
    /** Verification for the execution adapter: an independent read must find exactly this order. */
    async verify(context: TenantContext, submissionId: string) {
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.submission(submissionId),
      );
      if (!submission)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      if (!deps.purchasing)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      const result = await deps.purchasing.orders(
        context,
        submission.connectionId,
        {
          created: {
            lumaOrderId: submission.purchaseOrderId,
            createdSince: new Date(
              Date.parse(submission.requestedAt) - hour,
            ).toISOString(),
          },
        },
      );
      if (!result.ok)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      const matches = result.value.filter(
        (o) => o.data.lumaOrderId === submission.purchaseOrderId,
      );
      if (matches.length === 0)
        return { outcome: 'inconclusive' as const, observationRefs: [] };
      if (matches.length > 1)
        return {
          outcome: 'failed' as const,
          observationRefs: matches.map((m) => m.observationId),
        };

      return {
        outcome: matchesSubmission(submission, matches[0]!)
          ? ('passed' as const)
          : ('failed' as const),
        observationRefs: [matches[0]!.observationId],
      };
    },
    /** The submission an action belongs to, for execution adapters. */
    async submissionForAction(context: TenantContext, submissionId: string) {
      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const submission = await tx.submission(submissionId);
        const order = submission
          ? await tx.order(submission.purchaseOrderId)
          : null;

        return submission && order
          ? { submission, order, action: submissionAction(submission, order) }
          : null;
      });
    },
  };

  return service;
}

/** The exact action a submission asks admission to perform. */
function submissionAction(
  submission: Submission,
  order: Pick<PurchaseOrder, 'reference'>,
): ProposedAction {
  return {
    schemaVersion: 1,
    id: submission.actionId,
    tenantId: submission.tenantId,
    capability: 'purchase-orders.submit',
    capabilityVersion: '0',
    connectionId: submission.connectionId,
    target: { kind: 'purchase_order_submission', id: submission.id },
    parameters: {
      purchaseOrderId: submission.purchaseOrderId,
      reference: order.reference,
      supplierId: submission.supplier.externalId,
      supplierScope: submission.supplier.scopeKey,
      requestedDeliveryDate: submission.requestedDeliveryDate,
      // Canonical key order: stored submissions come back from jsonb with reordered keys.
      lines: canonicalJson(
        submission.lines.map((line) => ({
          lineId: line.lineId,
          sku: line.sku,
          quantity: line.quantity,
          unit: line.unit,
        })),
      ),
    },
    preconditions: {
      evidenceRefs: [submission.purchaseOrderId, submission.id],
      validUntil: submission.expiresAt,
    },
    expectedPostcondition: {
      lumaOrderId: submission.purchaseOrderId,
      lines: submission.lines.length,
    },
    risk: 'high',
    proposedBy: { kind: 'user', id: submission.requestedBy },
    expiresAt: submission.expiresAt,
  };
}

export type SupplierCommitments = ReturnType<typeof createSupplierCommitments>;
