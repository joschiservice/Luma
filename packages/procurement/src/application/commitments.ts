import type { AuditEntry } from '@luma/audit';
import type {
  ExternalId,
  SupplierOrderSnapshot,
  SupplierSnapshot,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError, requireRole, requireTenant } from '@luma/identity';
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
import type {
  PurchaseOrder,
  Supplier,
  SupplierLinkInput,
} from '../domain/procurement.js';
import {
  extractFacts,
  type ExtractionOutput,
  messageText,
} from './extraction.js';
import type { ProcurementEvent } from './procurement.js';

/** A connection that can act as a purchasing system. */
export interface PurchasingConnection {
  id: string;
  label: string;
  provider: string | null;
  status: string;
  canSubmit: boolean;
  canReadOrders: boolean;
  canListSuppliers: boolean;
}

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

export type PurchasingResult<T> =
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
  | { state: 'withheld'; reason: string }
  | { state: 'accepted' }
  | { state: 'verified' }
  | { state: 'failed'; reason: string }
  | { state: 'uncertain' };

/** Binds submissions to Action Admission, workspace policy and audited execution. */
export interface SubmissionAdmission {
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
  supplier(id: string): Promise<Supplier | null>;
  updateSupplier(supplier: Supplier): Promise<void>;
  history(orderId: string): Promise<ProcurementEvent[]>;
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
  digest(value: unknown): string;
  id(): string;
  /** Stable UUID derived from a name. */
  uuid(name: string): string;
  now(): Date;
  parse: {
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
      kind: Exclude<CommitmentKind, 'received'>;
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
    };
  };
}

/** What a person can do with a submission now, from persisted state. */
export interface SubmissionView extends Submission {
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
    requireRole(
      fresh,
      write ? ['owner', 'admin'] : ['owner', 'admin', 'member'],
    );
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
        now: deps.now(),
      }),
    };
  }

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
    const requester = context.actor.id === submission.requestedBy;
    const manager = context.actor.role !== 'member';
    const messages: Record<Submission['state'], string> = {
      approval_required: requester
        ? 'Waiting for a different owner or admin to approve sending this order.'
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
      state: expired ? 'expired' : submission.state,
      approvalOutcome: decision?.approval?.outcome ?? null,
      canApprove:
        !expired &&
        manager &&
        !requester &&
        submission.state === 'approval_required' &&
        !decision?.approval,
      canSend: !expired && requester && submission.state === 'approved',
      canCheck:
        manager && ['uncertain', 'submitting'].includes(submission.state),
      message: expired ? messages.expired : messages[submission.state],
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
  async function observe(
    context: TenantContext,
    submission: Submission,
    found: PurchasingOrder,
  ) {
    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const order = await tx.order(submission.purchaseOrderId);
      if (!order) return;
      const lineFor = (sku: ExternalId | null) =>
        submission.lines.find((l) => l.sku.externalId === sku?.externalId)
          ?.lineId ?? null;
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
      const canManage = context.actor.role !== 'member';

      return {
        ...data,
        submission: submission
          ? await submissionView(context, submission)
          : null,
        progress,
        stage: orderStage(data.order, submission, progress),
        draftVerified:
          !!data.order.origin.workflowRunId &&
          verifiedRuns.has(data.order.origin.workflowRunId),
        canManage,
        extraction: {
          available: deps.model.available && !!deps.model.gateway,
          reason: deps.model.available ? null : deps.model.reason,
        },
      };
    },
    /** Summarizes every order's stage, expected date and open attention for lists. */
    async summaries(context: TenantContext) {
      context = await authorize(context);
      const data = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) => {
          const orders = await tx.orders();

          return {
            orders,
            submissions: await tx.submissions(),
            commitments: await tx.commitments(),
            followUps: await tx.followUps(),
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
      const verifiedRuns = await verified(context, data.orders);

      return data.orders.map((order) => {
        const { progress, submission } = progressFor(order, {
          ...data,
          supplier: data.suppliers.get(order.supplierId) ?? null,
          verified: verifiedRuns,
        });

        return {
          id: order.id,
          stage: orderStage(order, submission, progress),
          expectedDate: progress.expectedDate,
          // A pending approval shows in the stage; count what needs an answer beyond it.
          attention: progress.attention.filter(
            (a) => a.kind !== 'submission_approval',
          ).length,
          overdue: progress.attention.some((a) =>
            ['confirmation_overdue', 'delivery_overdue'].includes(a.kind),
          ),
          nextOwner: progress.next.owner,
          externalOrderNumber: submission?.externalOrder?.orderNumber ?? null,
        };
      });
    },
    /** Lists attention across orders for Needs you, from persisted state only. */
    async pending(context: TenantContext) {
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
                (s) => !['rejected', 'expired', 'failed'].includes(s.state),
              )
              .map((s) => s.purchaseOrderId),
            ...commitments.map((c) => c.purchaseOrderId),
          ]);
          const orders = (
            await Promise.all([...orderIds].map((id) => tx.order(id)))
          ).filter(
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
        const view = submission
          ? await submissionView(context, submission)
          : null;
        for (const attention of progress.attention) {
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
                  : context.actor.role !== 'member',
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
        canManage: context.actor.role !== 'member',
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
            (s) => !['rejected', 'expired', 'failed'].includes(s.state),
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
      if (saved.state === 'approved') await dispatch(context, saved);

      return submissionView(
        context,
        (await deps.store.transaction(context.tenantId, false, (tx) =>
          tx.submission(saved.id),
        ))!,
      );
    },
    /**
     * Approves or rejects a submission. Approval comes from a different owner or admin; Luma then
     * dispatches it as the requester, exactly once.
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
      if (!['uncertain', 'submitting'].includes(submission!.state))
        return submissionView(context, submission!);
      const principal = await deps.principal(
        submission!.requestedBy,
        context.tenantId,
        `submission-check:${submissionId}`,
      );
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
    /** Records what a supplier said by hand, citing a message, or corrects a commitment. */
    async recordCommitment(
      context: TenantContext,
      orderId: string,
      input: unknown,
    ) {
      context = await authorize(context, true);
      const request = deps.parse.commitment(input);

      return command(
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
              quantity:
                request.kind === 'confirmed_quantity' ? request.quantity : null,
              date: ['promised_date', 'shipped'].includes(request.kind)
                ? request.date
                : null,
              text: request.kind === 'condition' ? request.text!.trim() : null,
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

      return deps.store.transaction(context.tenantId, true, async (tx) => {
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
      });
    },
    /** Accepts a supplier change, or records a follow-up and when to check again. */
    async respond(context: TenantContext, orderId: string, input: unknown) {
      context = await authorize(context, true);
      const request = deps.parse.followUp(input);
      const current = await service.order(context, orderId);
      const attention = current.progress.attention.find(
        (a) => a.key === request.key,
      );
      if (!attention) {
        const answered = current.followUps.find((f) => f.key === request.key);
        if (
          answered?.response === request.response &&
          answered.respondedBy === context.actor.id
        )
          return answered;
        conflict('This no longer needs a response. Refresh the order.');
      }
      if (
        ![
          'commitment_changed',
          'confirmation_overdue',
          'delivery_overdue',
        ].includes(attention!.kind)
      )
        conflict('Respond to this from its own review.');
      if (
        request.response === 'accepted' &&
        attention!.kind !== 'commitment_changed'
      )
        conflict('Record a follow-up and when to check again.');
      const now = deps.now();
      if (request.response === 'following_up') {
        const next = request.nextCheckAt
          ? Date.parse(request.nextCheckAt)
          : NaN;
        if (!(next > now.getTime()) || next > now.getTime() + 60 * 24 * hour)
          conflict('Choose when to check again, within the next 60 days.');
      }
      const followUp: FollowUp = {
        id: request.id,
        tenantId: context.tenantId,
        purchaseOrderId: orderId,
        key: request.key,
        response: request.response,
        note: request.note.trim(),
        nextCheckAt:
          request.response === 'following_up' ? request.nextCheckAt : null,
        respondedBy: context.actor.id,
        respondedAt: now.toISOString(),
      };

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        if (!(await tx.insertFollowUp(followUp)))
          conflict('Someone already responded. Refresh the order.');
        await tx.audit(
          audit(context, 'purchase_order.follow_up', request.id, orderId, {
            key: request.key,
            response: request.response,
            nextCheckAt: followUp.nextCheckAt ?? '',
          }),
        );

        return followUp;
      });
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
export function submissionAction(
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
