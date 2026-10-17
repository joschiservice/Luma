import type { Submission } from './commitments.js';
import type { PurchaseOrder } from './procurement.js';

/** Hours an approval request for a submission stays open. */
export const submissionApprovalHours = 24;

/** Whether a submission still occupies its order: it was not rejected, expired, failed or observe-only. */
export function isLiveSubmission(submission: Pick<Submission, 'state'>) {
  return !['rejected', 'expired', 'failed', 'not_executed'].includes(
    submission.state,
  );
}

/** Whether a submission waiting for approval has passed its approval deadline at `now` (epoch ms). */
export function approvalExpired(
  submission: Pick<Submission, 'state' | 'expiresAt'>,
  now: number,
) {
  return (
    submission.state === 'approval_required' &&
    Date.parse(submission.expiresAt) <= now
  );
}

/** A purchasing-system order as an independent read reported it. */
export interface PlacedOrder {
  supplier: { externalId: string };
  lines: {
    sku: { externalId: string } | null;
    /** Decimal string. */
    quantity: { amount: string };
  }[];
}

/** Whether a purchasing-system order carries exactly the approved supplier and lines. */
export function matchesSubmission(
  submission: Pick<Submission, 'supplier' | 'lines'>,
  order: PlacedOrder,
) {
  if (order.supplier.externalId !== submission.supplier.externalId)
    return false;
  const lines = order.lines;

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

/** The supplier's purchasing-system connection as the readiness check sees it. */
export interface SubmissionConnection {
  label: string;
  status: string;
  canSubmit: boolean;
  canReadOrders: boolean;
}

/**
 * Explains why an order can't be sent through its supplier's purchasing system, in the order a
 * person should fix them; empty when it can be sent. `connection` is undefined when the
 * connection was not looked up, and null when the supplier's linked connection is gone.
 * `lines` lists every order line once the supplier is linked.
 */
export function submissionBlockers(input: {
  order: Pick<PurchaseOrder, 'authority' | 'status'>;
  executionAvailable: boolean;
  linked: boolean;
  connection?: SubmissionConnection | null | undefined;
  lines: { sku: string; mapped: boolean }[];
}): string[] {
  const { order, connection } = input;
  const blockers: string[] = [];
  if (order.authority !== 'luma')
    blockers.push('This order is managed in an external system.');
  if (!['draft', 'open'].includes(order.status))
    blockers.push('Only draft and open orders can be sent.');
  if (!input.executionAvailable)
    blockers.push(
      'Sending orders is unavailable on this server. Ask an administrator to enable execution.',
    );
  if (!input.linked)
    blockers.push(
      'Link this supplier to its purchasing-system record before sending orders.',
    );
  if (connection !== undefined) {
    if (!connection || connection.status !== 'active')
      blockers.push(
        'The supplier’s purchasing-system connection is not active. Check the connection in Apps.',
      );
    else if (!connection.canSubmit || !connection.canReadOrders)
      blockers.push(
        `${connection.label} is not allowed to create and read purchase orders. Reconnect it with purchase-order access.`,
      );
  }
  for (const line of input.lines.filter((l) => !l.mapped))
    blockers.push(
      `${line.sku} has no linked item in ${connection?.label ?? 'the purchasing system'}. Link the SKU in Products first.`,
    );

  return blockers;
}

/** What a reader can do with a submission and the sentence that explains its state. */
export interface SubmissionActions {
  state: Submission['state'];
  canApprove: boolean;
  canSend: boolean;
  canCheck: boolean;
  message: string;
}

/**
 * Decides what a reader can do with a submission. Email submissions are handled in the
 * Operations Inbox, observe-only and expired ones can't be approved or sent, approval needs
 * someone other than the requester unless the decision allows self-approval, only the requester
 * sends, and managers recheck uncertain or stalled submissions.
 */
export function submissionActions(input: {
  submission: Submission;
  decision: {
    approval?: unknown;
    requireIndependentApproval?: boolean | undefined;
  } | null;
  expired: boolean;
  observeOnly: boolean;
  /** The reader requested the submission. */
  requester: boolean;
  /** The reader can manage procurement. */
  manager: boolean;
  /** The reader can approve this decision. */
  approver: boolean;
}): SubmissionActions {
  const { submission, decision, expired, observeOnly, requester } = input;
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
    state: expired ? 'expired' : submission.state,
    canApprove:
      submission.channel !== 'email' &&
      !observeOnly &&
      !expired &&
      input.approver &&
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
      input.manager &&
      ['uncertain', 'submitting'].includes(submission.state),
    message: observeOnly
      ? messages.not_executed
      : expired
        ? messages.expired
        : messages[submission.state],
  };
}
