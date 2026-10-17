import type {
  EffectIntent,
  PurchaseOrderRevisionInput,
  VerificationResult,
  WriteAcceptance,
} from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  isAppPermission,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import {
  canonicalJson,
  conflict,
  forbidden,
  notFound,
  unavailable,
} from '@luma/platform';
import type { PolicyDecision, ProposedAction } from '@luma/policies';

import type { OrderProgress, Submission } from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import type {
  PurchaseOrderChange,
  PurchaseOrderChangeInput,
  PurchaseOrderRevision,
} from '../domain/purchase-order-changes.js';
import { matchesPurchaseOrderChange } from '../domain/purchase-order-changes.js';
import type { PurchasingSystem, SubmissionExecution } from './commitments.js';
import {
  type PurchasingReadEvidence,
  purchasingReadEvidence,
  type PurchasingWriteReceipt,
  purchasingWriteReceipt,
} from './purchasing-reads.js';

export interface PurchaseOrderChangeStore {
  /** Serializes every order change with the procurement owner. */
  transaction<T>(
    tenantId: string,
    write: boolean,
    operation: (tx: {
      order(id: string): Promise<PurchaseOrder | null>;
      changes(
        orderId?: string,
        states?: PurchaseOrderChange['state'][],
      ): Promise<PurchaseOrderChange[]>;
      change(id: string): Promise<PurchaseOrderChange | null>;
      insert(change: PurchaseOrderChange): Promise<void>;
      save(change: PurchaseOrderChange): Promise<void>;
      revisions(orderId: string): Promise<PurchaseOrderRevision[]>;
      supplierLink(supplierId: string): Promise<{
        connectionId: string;
        externalId: string;
        scopeKey: string;
      } | null>;
      skuIdentity(
        connectionId: string,
        sku: string,
      ): Promise<{ externalId: string; scopeKey: string } | null>;
      apply(
        change: PurchaseOrderChange,
        observedAt: string,
        observationRefs: string[],
      ): Promise<void>;
      /** Stores a cited purchasing-system read; an already stored read is kept unchanged. */
      recordRead(evidence: PurchasingReadEvidence): Promise<void>;
      /** Stores a write receipt; an already stored receipt is kept unchanged. */
      recordWriteReceipt(receipt: PurchasingWriteReceipt): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

export interface PurchaseOrderChangeAdmission {
  prepare(
    context: TenantContext,
    change: PurchaseOrderChange,
    action: ProposedAction,
  ): Promise<PolicyDecision>;
  decision(
    context: TenantContext,
    id: string,
  ): Promise<
    | (PolicyDecision & {
        approval?: { outcome: 'approved' | 'rejected'; approverId: string };
        requireIndependentApproval?: boolean | undefined;
      })
    | null
  >;
  respond(
    context: TenantContext,
    id: string,
    outcome: 'approved' | 'rejected',
    expiresAt: string,
  ): Promise<void>;
  execute(
    context: TenantContext,
    change: PurchaseOrderChange,
  ): Promise<SubmissionExecution>;
  reconcile(
    context: TenantContext,
    change: PurchaseOrderChange,
  ): Promise<SubmissionExecution>;
}

/** Returns the exact high-risk change that approval and execution bind. */
function purchaseOrderChangeAction(
  change: PurchaseOrderChange,
): ProposedAction {
  return {
    schemaVersion: 1,
    id: change.actionId,
    tenantId: change.tenantId,
    capability: 'purchase-orders.revise',
    capabilityVersion: '0',
    connectionId: change.connectionId,
    target: { kind: 'purchase_order_change', id: change.id },
    parameters: {
      purchaseOrderId: change.purchaseOrderId,
      expectedRevision: change.baseline.revision,
      provider: canonicalJson(change.provider),
    },
    preconditions: {
      evidenceRefs: [change.id, change.purchaseOrderId],
      validUntil: change.expiresAt,
    },
    expectedPostcondition: { revision: change.proposed.revision },
    risk: 'high',
    proposedBy: { kind: 'user', id: change.requestedBy },
    expiresAt: change.expiresAt,
  };
}

/** Proposes revisions, refreshes authority at every step and reconciles uncertain writes by reading only. */
export function createPurchaseOrderChangeService(deps: {
  store: PurchaseOrderChangeStore;
  commitments: {
    order(
      context: TenantContext,
      id: string,
    ): Promise<{
      order: PurchaseOrder;
      supplier: Supplier | null;
      submission: Submission | null;
      progress: OrderProgress;
    }>;
    refresh(context: TenantContext, id: string): Promise<unknown>;
  };
  purchasing: PurchasingSystem | null;
  admission: PurchaseOrderChangeAdmission | null;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  principal(actorId: string, tenantId: string): Promise<TenantContext>;
  released(context: TenantContext): Promise<boolean>;
  canRevise(context: TenantContext, connectionId: string): Promise<boolean>;
  parse(input: unknown): PurchaseOrderChangeInput;
  digest(value: unknown): string;
  uuid(name: string): string;
  now(): Date;
  /** Reconciles derived incoming stock after verified owner changes; retried after fresh verification. */
  changed?(context: TenantContext, orderId: string): Promise<void>;
}) {
  async function authorize(context: TenantContext, write = false) {
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(fresh, write ? 'procurement.manage' : 'procurement.read');

    return fresh;
  }

  async function released(context: TenantContext) {
    if (!(await deps.released(context)))
      throw forbidden(
        'Purchase-order changes are not enabled for this workspace.',
      );
  }

  async function get(context: TenantContext, id: string) {
    const change = await deps.store.transaction(context.tenantId, false, (tx) =>
      tx.change(id),
    );
    if (!change) throw notFound('Order change not found.');

    return change;
  }

  async function save(context: TenantContext, change: PurchaseOrderChange) {
    return deps.store.transaction(context.tenantId, true, async (tx) => {
      const current = await tx.change(change.id);
      if (!current) throw notFound('Order change not found.');
      const transitions: Record<
        PurchaseOrderChange['state'],
        PurchaseOrderChange['state'][]
      > = {
        preparing: ['approval_required', 'failed'],
        approval_required: ['approved', 'rejected', 'expired', 'failed'],
        approved: ['submitting', 'failed', 'expired'],
        submitting: ['uncertain', 'verified', 'failed', 'approved'],
        uncertain: ['uncertain', 'verified', 'failed', 'approved'],
        verified: [],
        failed: [],
        rejected: [],
        expired: [],
      };
      if (!transitions[current.state].includes(change.state)) return current;
      await tx.save(change);

      return change;
    });
  }

  async function prepare(context: TenantContext, change: PurchaseOrderChange) {
    if (!deps.admission) throw conflict('Governed execution is unavailable.');
    const decision = await deps.admission.prepare(
      context,
      change,
      purchaseOrderChangeAction(change),
    );

    return save(context, {
      ...change,
      decisionId: decision.id,
      state:
        decision.outcome === 'approval_required'
          ? 'approval_required'
          : 'failed',
      failure:
        decision.outcome === 'approval_required'
          ? null
          : 'Policy does not allow this order change.',
    });
  }

  async function canApprove(
    context: TenantContext,
    change: PurchaseOrderChange,
  ) {
    const decision =
      change.state === 'approval_required' &&
      change.decisionId &&
      deps.admission
        ? await deps.admission.decision(context, change.decisionId)
        : null;

    return (
      !!decision &&
      decision.outcome === 'approval_required' &&
      change.expiresAt > deps.now().toISOString() &&
      hasPermission(context, 'procurement.manage') &&
      hasPermission(context, 'decisions.respond') &&
      (!decision.permission ||
        !isAppPermission(decision.permission) ||
        hasPermission(context, decision.permission)) &&
      (!decision.requireIndependentApproval ||
        context.actor.id !== change.requestedBy)
    );
  }

  async function execute(
    context: TenantContext,
    id: string,
    reconcile = false,
  ) {
    let change = await get(context, id);
    if (
      change.state === 'verified' ||
      change.state === 'rejected' ||
      change.state === 'failed'
    )
      return change;
    const principal = await deps.principal(
      change.requestedBy,
      context.tenantId,
    );
    await authorize(principal, true);
    await released(principal);
    if (!deps.admission)
      throw unavailable('Governed execution is unavailable.');
    if (reconcile) {
      if (!['submitting', 'uncertain'].includes(change.state)) return change;
    } else {
      if (change.state !== 'approved') return change;
      change = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const current = await tx.change(id);
          if (!current || current.state !== 'approved')
            return current ?? change;
          const order = await tx.order(change.purchaseOrderId);
          if (
            !order ||
            order.revision !== change.baseline.revision ||
            order.status !== 'open'
          )
            throw conflict(
              'This order changed after approval. Nothing was sent.',
            );
          const next = { ...current, state: 'submitting' as const };
          await tx.save(next);

          return next;
        },
      );
      if (change.state !== 'submitting') return change;
    }
    const result = reconcile
      ? await deps.admission.reconcile(principal, change)
      : await deps.admission.execute(principal, change);
    if (result.state === 'verified') return get(context, id);
    if (result.state === 'failed' || result.state === 'withheld')
      return save(context, {
        ...change,
        state: 'failed',
        failure: result.reason,
      });
    if (reconcile && result.state === 'not_started')
      return save(context, { ...change, state: 'approved', failure: null });
    if (result.state === 'not_executed')
      return save(context, {
        ...change,
        state: 'failed',
        failure:
          'The workspace is observing only. No purchasing-system change was made.',
      });

    return save(context, { ...change, state: 'uncertain' });
  }

  return {
    /** Lists active revision work from storage with current permissions and approval rules; never reads a provider. */
    async pending(context: TenantContext) {
      context = await authorize(context);
      if (!(await deps.released(context))) return [];
      const changes = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) =>
          tx.changes(undefined, [
            'approval_required',
            'approved',
            'submitting',
            'uncertain',
          ]),
      );

      return Promise.all(
        changes.map(async (change) => {
          const allowed = await canApprove(context, change);

          return {
            id: change.id,
            kind: 'revision' as const,
            orderId: change.purchaseOrderId,
            reference: change.baseline.reference,
            state:
              change.state === 'approval_required'
                ? ('approval_required' as const)
                : change.state === 'approved'
                  ? ('approved' as const)
                  : ('uncertain' as const),
            requestedBy: change.requestedBy,
            requestedAt: change.requestedAt,
            expiresAt:
              change.state === 'approval_required' ||
              change.state === 'approved'
                ? change.expiresAt
                : null,
            canApprove: allowed,
            quantity: change.proposed.lines.reduce(
              (total, line) => total + line.quantity,
              0,
            ),
          };
        }),
      );
    },
    /** Lists source-aware change availability, pending approvals and immutable previous revisions. */
    async list(context: TenantContext, orderId: string) {
      context = await authorize(context);
      const enabled = await deps.released(context);
      const record = await deps.commitments.order(context, orderId);
      const changes = enabled
        ? await deps.store.transaction(context.tenantId, false, (tx) =>
            tx.changes(orderId),
          )
        : [];
      const canRevise =
        !changes.some((change) =>
          [
            'preparing',
            'approval_required',
            'approved',
            'submitting',
            'uncertain',
          ].includes(change.state),
        ) &&
        record.order.authority === 'luma' &&
        record.order.status === 'open' &&
        enabled &&
        !!record.submission?.externalOrder &&
        record.submission.channel !== 'email' &&
        !!deps.admission &&
        (await deps.canRevise(context, record.submission.connectionId));

      return {
        enabled,
        canManage: hasPermission(context, 'procurement.manage'),
        canRevise,
        cancelAvailable: false as const,
        cancelReasonCode: record.progress.lines.some(
          (line) => line.received > 0,
        )
          ? ('received' as const)
          : ('unsupported' as const),
        cancelReason: record.progress.lines.some((line) => line.received > 0)
          ? 'An order with received goods cannot be cancelled.'
          : 'JTL-Wawi 2.2 does not expose purchase-order cancellation. Arrange cancellation in your purchasing system before replacing the order.',
        changes: await Promise.all(
          changes.map(async (change) => ({
            ...change,
            canApprove: await canApprove(context, change),
          })),
        ),
        revisions: enabled
          ? await deps.store.transaction(context.tenantId, false, (tx) =>
              tx.revisions(orderId),
            )
          : [],
      };
    },
    /** Freezes one source operation with reviewed commitments and a revision-checked owner snapshot. */
    async propose(context: TenantContext, orderId: string, input: unknown) {
      context = await authorize(context, true);
      await released(context);
      const request = deps.parse(input);
      const digest = deps.digest({
        actorId: context.actor.id,
        orderId,
        request,
      });
      const existing = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.change(request.id),
      );
      if (existing) {
        if (existing.requestDigest !== digest)
          throw conflict(
            'This request ID was already used for a different order change.',
          );
        if (existing.state === 'preparing' && deps.admission)
          return prepare(context, existing);

        return existing;
      }
      const record = await deps.commitments.order(context, orderId),
        order = record.order,
        submission = record.submission;
      if (request.operation.kind === 'cancel') {
        if (record.progress.lines.some((line) => line.received > 0))
          throw conflict('An order with received goods cannot be cancelled.');
        throw conflict(
          'The JTL-Wawi API does not expose purchase-order cancellation.',
        );
      }
      if (
        order.authority !== 'luma' ||
        order.status !== 'open' ||
        order.revision !== request.expectedRevision
      )
        throw conflict(
          'Only the current revision of a submitted, open Luma order can be changed.',
        );
      if (
        !record.supplier?.link ||
        record.supplier.link.connectionId !== submission?.connectionId ||
        !submission?.externalOrder ||
        submission.channel === 'email' ||
        !deps.purchasing ||
        !deps.admission ||
        !(await deps.canRevise(context, submission.connectionId))
      )
        throw conflict(
          'This purchasing connection does not support approved order revisions.',
        );
      const read = await deps.purchasing.orders(
        context,
        submission.connectionId,
        {
          order: {
            externalId: submission.externalOrder.externalId,
            scopeKey: submission.supplier.scopeKey,
          },
        },
      );
      if (
        !read.ok ||
        read.value.length !== 1 ||
        read.value[0]!.completeness !== 'complete'
      )
        throw conflict(
          'A complete current purchasing-system read is required before changing this order.',
        );
      const source = read.value[0]!;
      if (
        source.data.lumaOrderId !== orderId ||
        source.data.supplier.externalId !== submission.supplier.externalId ||
        source.data.lines.length !== order.lines.length
      )
        throw conflict(
          'The purchasing-system order changed outside Luma. Review its current lines before proposing a revision.',
        );
      const linked = await deps.store.transaction(
        context.tenantId,
        false,
        async (tx) =>
          Promise.all(
            order.lines.map(async (line) => ({
              line,
              identity: await tx.skuIdentity(submission.connectionId, line.sku),
            })),
          ),
      );
      if (
        linked.some(({ line, identity }) => {
          const matches = source.data.lines.filter(
            (sourceLine) =>
              identity &&
              sourceLine.sku?.externalId === identity.externalId &&
              sourceLine.sku?.scopeKey === identity.scopeKey,
          );
          const actual = matches[0];

          return (
            matches.length !== 1 ||
            !actual ||
            actual.quantity.unit !== line.unit ||
            (actual.requestedDeliveryDate ??
              source.data.requestedDeliveryDate) !==
              (line.requestedDeliveryDate ??
                submission.requestedDeliveryDate) ||
            Math.abs(Number(actual.quantity.amount) - line.quantity) > 1e-6
          );
        })
      )
        throw conflict(
          'The purchasing-system quantities differ from the current Luma revision. Review the source order before changing another position.',
        );
      if (!['open', 'released'].includes(source.data.status))
        throw conflict(
          'JTL allows quantity, delivery-date, added-line and removed-line changes only while the purchase order is Open or Released.',
        );
      let operation: PurchaseOrderRevisionInput['operation'];
      const lines = order.lines.map((line) => ({ ...line }));
      let affectsCommitments = false;
      if (request.operation.kind === 'add_line') {
        const op = request.operation;
        if (
          lines.some(
            (line) => line.id === op.line.id || line.sku === op.line.sku,
          ) ||
          op.line.unit !== 'each'
        )
          throw conflict('Add a distinct product line in the supported unit.');
        const sku = await deps.store.transaction(
          context.tenantId,
          false,
          (tx) => tx.skuIdentity(submission.connectionId, op.line.sku),
        );
        if (!sku)
          throw conflict(
            'The new product must be linked to exactly one item in this purchasing system.',
          );
        lines.push({
          ...op.line,
          requestedDeliveryDate: op.requestedDeliveryDate,
        });
        operation = {
          kind: 'add_line',
          sku,
          quantity: op.line.quantity,
          requestedDeliveryDate: op.requestedDeliveryDate,
        };
      } else {
        const op = request.operation,
          index = lines.findIndex((line) => line.id === op.lineId),
          line = lines[index];
        if (!line) throw conflict('Order line not found.');
        const identity = await deps.store.transaction(
          context.tenantId,
          false,
          (tx) => tx.skuIdentity(submission.connectionId, line.sku),
        );
        const current = source.data.lines.filter(
          (value) =>
            identity &&
            value.sku?.externalId === identity.externalId &&
            value.sku?.scopeKey === identity.scopeKey,
        );
        if (current.length !== 1)
          throw conflict(
            'The current provider line must be mapped unambiguously before changing it.',
          );
        const providerLine = current[0]!;
        if (
          providerLine.deliveredQuantity === null ||
          Number(providerLine.deliveredQuantity) > 0
        )
          throw conflict('Received lines cannot be changed or removed.');
        const commitment = record.progress.lines.find(
          (value) => value.lineId === op.lineId,
        );
        affectsCommitments =
          providerLine.confirmed === true ||
          providerLine.confirmedQuantity !== null ||
          providerLine.confirmedDeliveryDate !== null ||
          (!!commitment &&
            (commitment.confirmed !== null ||
              commitment.shipped !== null ||
              commitment.shippedDate !== null));
        if (op.kind === 'remove_line') {
          if (lines.length <= 1)
            throw conflict('A purchase order must retain at least one line.');
          lines.splice(index, 1);
          operation = { kind: 'remove_line', line: providerLine.id };
        } else {
          if (
            (op.quantity === undefined ||
              op.quantity === Number(providerLine.quantity.amount)) &&
            (!op.requestedDeliveryDate ||
              op.requestedDeliveryDate === providerLine.requestedDeliveryDate)
          )
            throw conflict(
              'Choose a different quantity or requested delivery date.',
            );
          lines[index] = {
            ...line,
            ...(op.quantity !== undefined ? { quantity: op.quantity } : {}),
            ...(op.requestedDeliveryDate
              ? { requestedDeliveryDate: op.requestedDeliveryDate }
              : {}),
          };
          operation = {
            kind: 'update_line',
            line: providerLine.id,
            ...(op.quantity !== undefined ? { quantity: op.quantity } : {}),
            ...(op.requestedDeliveryDate
              ? { requestedDeliveryDate: op.requestedDeliveryDate }
              : {}),
          };
        }
      }
      const now = deps.now().toISOString();
      const change: PurchaseOrderChange = {
        id: request.id,
        tenantId: context.tenantId,
        purchaseOrderId: orderId,
        connectionId: submission.connectionId,
        actionId: deps.uuid(`order-change-action:${request.id}`),
        decisionId: null,
        request,
        requestDigest: digest,
        requestedBy: context.actor.id,
        requestedAt: now,
        expiresAt: new Date(+deps.now() + 86400000).toISOString(),
        state: 'preparing',
        baseline: order,
        proposed: {
          ...order,
          lines,
          revision: order.revision + 1,
          updatedAt: now,
        },
        provider: {
          order: { externalId: source.externalId, scopeKey: source.scopeKey },
          expected: source.data,
          operation,
        },
        affectsCommitments,
        decidedBy: null,
        verifiedAt: null,
        observationRefs: [],
        failure: null,
      };
      await deps.store.transaction(context.tenantId, true, async (tx) => {
        const current = await tx.order(orderId);
        if (current?.revision !== order.revision)
          throw conflict('The order changed while it was being reviewed.');
        if (
          (await tx.changes(orderId)).some((v) =>
            [
              'preparing',
              'approval_required',
              'approved',
              'submitting',
              'uncertain',
            ].includes(v.state),
          )
        )
          throw conflict(
            'An existing order change still needs approval or verification.',
          );
        await tx.insert(change);
      });

      return prepare(context, change);
    },
    /** Approves the exact revision and dispatches it as its requester; workspace approval rules still apply. */
    async decide(
      context: TenantContext,
      id: string,
      outcome: 'approved' | 'rejected',
    ) {
      context = await authorize(context, true);
      await released(context);
      requirePermission(context, 'decisions.respond');
      let change = await get(context, id);
      if (change.state !== 'approval_required') return change;
      if (!deps.admission || !change.decisionId)
        throw conflict('This order change has no active approval request.');
      if (change.expiresAt <= deps.now().toISOString())
        return save(context, { ...change, state: 'expired' });
      const currentDecision = await deps.admission.decision(
        context,
        change.decisionId,
      );
      if (
        currentDecision?.permission &&
        isAppPermission(currentDecision.permission)
      )
        requirePermission(context, currentDecision.permission);
      await deps.admission.respond(
        context,
        change.decisionId,
        outcome,
        change.expiresAt,
      );
      const decision = await deps.admission.decision(
        context,
        change.decisionId,
      );
      if (!decision?.approval) throw conflict('The approval was not recorded.');
      change = await save(context, {
        ...change,
        state:
          decision.approval.outcome === 'approved' ? 'approved' : 'rejected',
        decidedBy: decision.approval.approverId,
      });

      return change.state === 'approved' ? execute(context, id) : change;
    },
    /** Dispatches approved work as the requester after restoring a stopped process. */
    async send(context: TenantContext, id: string) {
      context = await authorize(context, true);
      await released(context);

      const change = await get(context, id);
      if (change.state === 'preparing') return prepare(context, change);

      return execute(context, id);
    },
    /** Reads after an uncertain attempt; no provider write is repeated. */
    async check(context: TenantContext, id: string) {
      context = await authorize(context, true);
      await released(context);

      return execute(context, id, true);
    },
    /** Matches the exact stored request to an admitted effect and current owner revision. */
    async eligible(
      context: TenantContext,
      step: { subject?: { kind: string; id: string }; action: unknown },
    ) {
      try {
        context = await authorize(context, true);
      } catch {
        return false;
      }
      if (
        step.subject?.kind !== 'purchase_order_change' ||
        !(await deps.released(context))
      )
        return false;

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const change = await tx.change(step.subject!.id),
          order = change ? await tx.order(change.purchaseOrderId) : null;
        const link = order ? await tx.supplierLink(order.supplierId) : null;

        return (
          !!link &&
          link.connectionId === change?.connectionId &&
          link.externalId === change.provider.expected.supplier.externalId &&
          link.scopeKey === change.provider.expected.supplier.scopeKey &&
          !!change &&
          !!order &&
          ['preparing', 'approval_required', 'approved', 'submitting'].includes(
            change.state,
          ) &&
          order.revision === change.baseline.revision &&
          order.status === 'open' &&
          canonicalJson(step.action) ===
            canonicalJson(purchaseOrderChangeAction(change))
        );
      });
    },
    /** Returns provider input only for the immutable admitted action. */
    async forAction(context: TenantContext, intent: EffectIntent) {
      context = await authorize(context, true);
      await released(context);
      const change = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.change(intent.target.id),
      );

      return change &&
        canonicalJson(purchaseOrderChangeAction(change)) ===
          canonicalJson(intent)
        ? { change, input: change.provider }
        : null;
    },
    /**
     * Stores the purchasing system's acceptance of an order change as procurement's write
     * receipt and returns its ID, which execution cites. It records what already happened, so it
     * does not recheck authority. Throws when the change is unknown or the acceptance belongs to
     * another connection; execution then cites nothing and the outcome stays unknown.
     */
    async storeWriteReceipt(
      context: TenantContext,
      changeId: string,
      acceptance: WriteAcceptance,
    ) {
      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const change = await tx.change(changeId);
        if (
          !change ||
          change.connectionId !== acceptance.connectionId ||
          acceptance.capability !== 'purchase-orders.revise'
        )
          throw conflict('The receipt does not belong to this order change.');
        const receipt = purchasingWriteReceipt(
          context.tenantId,
          change.purchaseOrderId,
          { purpose: 'revision', id: change.id },
          deps.uuid(
            `write-receipt:${context.tenantId}:${acceptance.idempotencyKey}`,
          ),
          acceptance,
        );
        await tx.recordWriteReceipt(receipt);

        return receipt.id;
      });
    },
    /** Independently reads and then commits the new local revision, keeping the old revision immutable. */
    async verify(
      context: TenantContext,
      changeId: string,
    ): Promise<VerificationResult> {
      context = await authorize(context, true);
      await released(context);
      const change = await get(context, changeId),
        observedAt = deps.now().toISOString();
      if (
        !['approved', 'submitting', 'uncertain', 'verified'].includes(
          change.state,
        ) ||
        !deps.purchasing
      )
        return {
          outcome: 'inconclusive',
          observationRefs: [],
          observedAt,
          evaluatorVersion: 'purchase-order-change/1',
        };
      const read = await deps.purchasing.orders(context, change.connectionId, {
        order: change.provider.order,
      });
      if (!read.ok || read.value.length !== 1)
        return {
          outcome: 'inconclusive',
          observationRefs: [],
          observedAt,
          evaluatorVersion: 'purchase-order-change/1',
        };
      const source = read.value[0]!,
        matches =
          source.completeness === 'complete' &&
          source.observedAt >= change.requestedAt &&
          matchesPurchaseOrderChange(change, source.data);
      const evidence = purchasingReadEvidence(
        context.tenantId,
        change.connectionId,
        change.purchaseOrderId,
        { purpose: 'revision', id: change.id },
        source,
      );
      if (!matches) {
        await deps.store.transaction(context.tenantId, true, (tx) =>
          tx.recordRead(evidence),
        );

        return {
          outcome: 'inconclusive',
          observationRefs: [source.observationId],
          observedAt: source.observedAt,
          evaluatorVersion: 'purchase-order-change/1',
        };
      }
      await deps.store.transaction(context.tenantId, true, async (tx) => {
        await tx.recordRead(evidence);
        const current = await tx.change(changeId);
        if (!current || current.state === 'verified') return;
        const order = await tx.order(change.purchaseOrderId);
        if (order?.revision !== change.baseline.revision)
          throw conflict(
            'The local order changed while the source revision was being verified.',
          );
        await tx.apply(change, source.observedAt, [source.observationId]);
        await tx.save({
          ...current,
          state: 'verified',
          verifiedAt: source.observedAt,
          observationRefs: [source.observationId],
        });
      });
      await deps
        .changed?.(context, change.purchaseOrderId)
        .catch(() => undefined);
      await deps.commitments
        .refresh(context, change.purchaseOrderId)
        .catch(() => undefined);

      return {
        outcome: 'passed',
        observationRefs: [source.observationId],
        observedAt: source.observedAt,
        evaluatorVersion: 'purchase-order-change/1',
      };
    },
  };
}

export type PurchaseOrderChanges = ReturnType<
  typeof createPurchaseOrderChangeService
>;
