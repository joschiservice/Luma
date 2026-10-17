import type { ExternalId } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { canonicalJson } from '@luma/platform';
import type { ProposedAction } from '@luma/policies';

import type {
  CommitmentKind,
  PurchasingObservation,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder } from '../domain/procurement.js';
import { matchesSubmission } from '../domain/submissions.js';
import { type CommitmentContext, hour } from './commitment-context.js';
import type { PurchasingOrder, SubmissionExecution } from './commitments.js';

/**
 * Executes admitted submissions exactly once and verifies them by reading the purchasing system:
 * dispatch, settlement of execution results, observed confirmations and receipts, the background
 * monitor and the hooks admission and execution adapters call.
 */
export function createSubmissionExecution({
  deps,
  authorize,
  audit,
  progressFor,
  lineMapping,
  saveSubmission,
}: CommitmentContext) {
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

  /** Records an observation and the commitments it evidences; repeated values are not duplicated. */
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
    if (!found || !matchesSubmission(submission, found.data))
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
      tx.order(submission.purchaseOrderId),
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

  /** Moves an approved submission to submitting, executes it once and settles the result. */
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

  return {
    locate,
    observe,
    settle,
    dispatch,
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
        outcome: matchesSubmission(submission, matches[0]!.data)
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
