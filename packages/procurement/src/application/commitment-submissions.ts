import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  isAppPermission,
  MembershipSuspendedError,
} from '@luma/identity';
import { conflict, notFound, unavailable } from '@luma/platform';
import type { PolicyDecision } from '@luma/policies';

import type { Submission } from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import {
  approvalExpired,
  isLiveSubmission,
  submissionActions,
  submissionApprovalHours,
  submissionBlockers,
} from '../domain/submissions.js';
import { type CommitmentContext, hour } from './commitment-context.js';
import {
  type createSubmissionExecution,
  submissionAction,
} from './commitment-execution.js';
import type { CommitmentTransaction, SubmissionView } from './commitments.js';

/**
 * Approval-controlled submissions: readiness, requesting approval, deciding, sending and
 * rechecking purchasing-system submissions, and recording verified email submissions.
 */
export function createSubmissionRequests(
  { deps, authorize, audit, lineMapping, saveSubmission }: CommitmentContext,
  {
    dispatch,
    settle,
  }: Pick<ReturnType<typeof createSubmissionExecution>, 'dispatch' | 'settle'>,
) {
  /** What a person can do with a submission now, from persisted state and admission. */
  async function submissionView(
    context: TenantContext,
    submission: Submission,
  ): Promise<SubmissionView> {
    const decision =
      submission.decisionId && deps.admission
        ? await deps.admission.decision(context, submission.decisionId)
        : null;
    const expired = approvalExpired(submission, deps.now().getTime());
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

    return {
      ...submission,
      observeOnly,
      approvalOutcome: decision?.approval?.outcome ?? null,
      ...submissionActions({
        submission,
        decision,
        expired,
        observeOnly,
        requester,
        manager,
        approver,
      }),
    };
  }

  /** Explains whether this order can be sent through its supplier's purchasing system. */
  async function readiness(
    context: TenantContext,
    tx: CommitmentTransaction,
    order: PurchaseOrder,
    supplier: Supplier | null,
  ) {
    const link = supplier?.link ?? null;
    const connection =
      link && deps.purchasing
        ? ((await deps.purchasing.connections(context)).find(
            (c) => c.id === link.connectionId,
          ) ?? null)
        : undefined;
    const lines = link ? await lineMapping(tx, order, link.connectionId) : [];
    const blockers = submissionBlockers({
      order,
      executionAvailable: !!deps.admission && !!deps.purchasing,
      linked: !!link,
      connection,
      lines: lines.map((l) => ({ sku: l.line.sku, mapped: !!l.sku })),
    });

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

  return {
    submissionView,
    readiness,
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
        throw conflict('Choose a delivery date that is today or later.');
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
          throw conflict(
            'This request ID was already used. Refresh before trying again.',
          );

        return submissionView(context, existing);
      }
      if (!deps.admission)
        throw unavailable('Sending orders is unavailable on this server.');
      const prepared = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const order = await tx.order(orderId);
          if (!order) throw notFound('Purchase order not found');
          const supplier = await tx.supplier(order.supplierId);
          const ready = await readiness(context, tx, order, supplier);
          if (!ready.ready) throw conflict(ready.blockers[0]!);
          const live = (await tx.submissions([orderId])).find(isLiveSubmission);
          if (live && !approvalExpired(live, deps.now().getTime()))
            throw conflict('This order already has a submission in progress.');
          if (live) await saveSubmission(tx, live, { state: 'expired' });
          const link = supplier!.link!;
          const mapping = await lineMapping(tx, order, link.connectionId);
          const now = deps.now();
          const expiresAt = new Date(
            now.getTime() + submissionApprovalHours * hour,
          ).toISOString();
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

          return { submission, order };
        },
      );
      const action = submissionAction(prepared.submission, prepared.order);
      let decision: PolicyDecision;
      try {
        decision = await deps.admission.prepare(
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
        throw unavailable(
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
        throw unavailable('Sending orders is unavailable on this server.');
      const submission = await deps.store.transaction(
        context.tenantId,
        false,
        (tx) => tx.submission(submissionId),
      );
      if (!submission) throw notFound('Submission not found');
      if (submission.channel === 'email')
        throw conflict(
          'Review and send this supplier email in the Operations Inbox.',
        );
      const view = await submissionView(context, submission);
      if (!view.canApprove || submission.decisionId !== request.decisionId)
        throw conflict(
          'This request changed, expired or needs a different approver. Refresh it.',
        );
      await deps.admission.respond(
        context,
        request.decisionId,
        request.outcome,
        submission.expiresAt,
      );
      const decided = await deps.store.transaction(
        context.tenantId,
        true,
        async (tx) => {
          const saved = await saveSubmission(tx, submission, {
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
      if (!submission) throw notFound('Submission not found');
      if (submission.channel === 'email')
        throw conflict(
          'Review and send this supplier email in the Operations Inbox.',
        );
      if (
        context.actor.id === submission.requestedBy &&
        [
          'submitted',
          'failed',
          'rejected',
          'expired',
          'uncertain',
          'submitting',
        ].includes(submission.state)
      )
        return submissionView(context, submission);
      const view = await submissionView(context, submission);
      if (!view.canSend)
        throw conflict('Only the requester can send an approved submission.');
      await dispatch(context, submission);

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
      if (!submission) throw notFound('Submission not found');
      if (!deps.admission)
        throw unavailable('Sending orders is unavailable on this server.');
      if (submission.channel === 'email')
        throw conflict(
          'Check the existing supplier email in the Operations Inbox.',
        );
      if (!['uncertain', 'submitting'].includes(submission.state))
        return submissionView(context, submission);
      const principal = await deps
        .principal(
          submission.requestedBy,
          context.tenantId,
          `submission-check:${submissionId}`,
        )
        .catch((error: unknown) => {
          if (error instanceof MembershipSuspendedError)
            throw conflict(
              'The person who requested this order can’t access this workspace right now. Luma checks it after their access is restored.',
            );
          throw error;
        });
      const execution = await deps.admission.reconcile(principal, submission);
      await settle(principal, submissionId, execution);

      return submissionView(
        context,
        (await deps.store.transaction(context.tenantId, false, (tx) =>
          tx.submission(submissionId),
        ))!,
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
          if (!order) throw notFound('Purchase order not found');
          const supplier = await tx.supplier(order.supplierId);
          const prior = await tx.submission(request.id);
          if (
            !prior &&
            (supplier?.link ||
              order.authority !== 'luma' ||
              !['draft', 'open'].includes(order.status))
          )
            throw conflict('This order cannot be sent through email.');
          if (
            prior &&
            (prior.channel !== 'email' ||
              prior.purchaseOrderId !== request.purchaseOrderId ||
              prior.outgoing?.outboundId !== request.outboundId ||
              prior.requestedBy !== context.actor.id)
          )
            throw conflict('This email submission ID was already used.');
          if (prior?.state === 'submitted' && request.state === 'submitted')
            return { submission: prior, order };
          if (
            !prior &&
            (await tx.submissions([order.id])).some(
              (s) => !['failed', 'rejected', 'expired'].includes(s.state),
            )
          )
            throw conflict(
              'An active submission already exists for this order.',
            );
          const now = deps.now().toISOString();
          const submission: Submission = {
            id: request.id,
            tenantId: context.tenantId,
            purchaseOrderId: order.id,
            channel: 'email',
            outgoing: {
              outboundId: request.outboundId,
              threadId: request.threadId,
              sentMessageId: request.sentMessageId ?? null,
            },
            connectionId: request.connectionId,
            supplier: { externalId: order.supplierId, scopeKey: '' },
            requestedDeliveryDate:
              prior?.requestedDeliveryDate ?? request.requestedDeliveryDate,
            lines: order.lines.map((line) => ({
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
              order.id,
              {
                state: request.state,
                outboundId: request.outboundId,
                threadId: request.threadId,
              },
              [request.outboundId],
            ),
          );

          return { submission, order };
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
  };
}
