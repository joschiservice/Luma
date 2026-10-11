import type { PurchaseOrder, PurchaseOrderLine } from './procurement.js';

/**
 * What a supplier or the purchasing system says about an order. `received` is booked goods
 * receipt and may only come from a purchasing-system read; `shipped` is a supplier claim.
 */
export type CommitmentKind =
  'confirmed_quantity' | 'promised_date' | 'shipped' | 'received' | 'condition';

/** Where a commitment came from. Every source stays attached to the commitment it produced. */
export type CommitmentSource =
  | {
      kind: 'purchasing_system';
      connectionId: string;
      observationId: string;
      observedAt: string;
      externalOrderId: string;
    }
  | {
      kind: 'communication';
      communicationId: string;
      /** Character offsets into the message text (subject, blank line, body). */
      span: { start: number; end: number };
      /** Null when a person recorded the fact by hand. */
      extraction: { id: string; factId: string; model: string } | null;
    }
  | { kind: 'correction'; reason: string };

/**
 * Confirmed commitments count. `needs_review` is a candidate a person must check; `rejected`
 * stays as history. Values are never edited; corrections add a new commitment.
 */
export type CommitmentStatus = 'confirmed' | 'needs_review' | 'rejected';

export interface Commitment {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  /** Null for facts about the whole order. */
  lineId: string | null;
  kind: CommitmentKind;
  /** Decimal quantity in the line's unit, for `confirmed_quantity` and `received`. */
  quantity: number | null;
  /** Calendar date (YYYY-MM-DD) for `promised_date` and `shipped`. */
  date: string | null;
  /** Short supplier wording for `condition`. */
  text: string | null;
  source: CommitmentSource;
  status: CommitmentStatus;
  /** Why the commitment needs review, when it does. */
  reviewReasons: ReviewReason[];
  /** The commitment this one corrects. */
  supersedes: string | null;
  recordedAt: string;
  recordedBy: { kind: 'user' | 'luma'; id: string };
  review: { outcome: 'confirmed' | 'rejected'; by: string; at: string } | null;
}

export type ReviewReason =
  | 'low_confidence'
  | 'quantity_changed'
  | 'date_later'
  | 'unmatched_line'
  | 'supplier_condition';

export type SubmissionState =
  | 'not_executed'
  | 'approval_required'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'submitting'
  | 'uncertain'
  | 'submitted'
  | 'failed';

/** One attempt to place a Luma purchase order in the supplier's purchasing system. */
export interface Submission {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  connectionId: string;
  supplier: { externalId: string; scopeKey: string };
  requestedDeliveryDate: string;
  lines: {
    lineId: string;
    sku: { externalId: string; scopeKey: string };
    quantity: number;
    unit: string;
  }[];
  actionId: string;
  decisionId: string | null;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  state: SubmissionState;
  /** The purchasing-system order, once an independent read found it. */
  externalOrder: { externalId: string; orderNumber: string | null } | null;
  /** When the order was independently found in the purchasing system. */
  submittedAt: string | null;
  /** Approver, or the person who rejected the submission. */
  decidedBy: string | null;
  decidedAt: string | null;
  failure: string | null;
  updatedAt: string;
}

/** Terms Luma uses to follow up on a supplier. */
export interface SupplierTerms {
  /** Hours after submission by which the supplier should confirm. */
  confirmationHours: number;
}

export const defaultSupplierTerms: SupplierTerms = { confirmationHours: 48 };

/** A person's response to something that needed attention, keyed by what they answered. */
export interface FollowUp {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  key: string;
  response: 'accepted' | 'following_up';
  note: string;
  /** When Luma should check again; null for accepted changes. */
  nextCheckAt: string | null;
  respondedBy: string;
  respondedAt: string;
}

export type LineStage =
  | 'not_submitted'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'changed'
  | 'partially_received'
  | 'received'
  | 'cancelled';

export interface LineProgress {
  lineId: string;
  sku: string;
  description: string;
  unit: string;
  ordered: number;
  /** Supplier-confirmed quantity; null until confirmed. */
  confirmed: number | null;
  confirmedSource: CommitmentSource['kind'] | null;
  promisedDate: string | null;
  requestedDate: string | null;
  /** Date the goods are expected: promised, else requested. */
  expectedDate: string | null;
  /** Booked goods receipt from the purchasing system; 0 until observed. */
  received: number;
  receivedObservedAt: string | null;
  /** Units still expected: confirmed (or ordered) minus received, never negative. */
  outstanding: number;
  shippedDate: string | null;
  stage: LineStage;
  overdue: boolean;
}

export type MilestoneKey = 'drafted' | 'submitted' | 'confirmed' | 'received';

export type MilestoneState =
  | 'complete'
  | 'partial'
  | 'in_progress'
  | 'attention'
  | 'pending'
  | 'not_started'
  | 'stopped';

export interface Milestone {
  key: MilestoneKey;
  state: MilestoneState;
  at: string | null;
  /** Short explanation of the evidence behind the state. */
  evidence: string;
}

export type AttentionKind =
  | 'submission_approval'
  | 'submission_uncertain'
  | 'review_commitment'
  | 'commitment_changed'
  | 'confirmation_overdue'
  | 'delivery_overdue';

/** Something a person must decide about this order now. */
export interface Attention {
  key: string;
  kind: AttentionKind;
  lineId: string | null;
  commitmentId: string | null;
  submissionId: string | null;
  /** When it became due; past deadlines rank first. */
  dueAt: string;
  summary: string;
}

export type NextOwner =
  'buyer' | 'approver' | 'supplier' | 'warehouse' | 'luma' | 'none';

export interface NextAction {
  owner: NextOwner;
  title: string;
  detail: string;
}

export interface OrderProgress {
  milestones: Milestone[];
  lines: LineProgress[];
  /** Earliest expected date of lines that are still outstanding. */
  expectedDate: string | null;
  confirmationDueAt: string | null;
  attention: Attention[];
  next: NextAction;
}

const dateOnly = (iso: string) => iso.slice(0, 10);

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** Formats a quantity without float noise. */
function formatQuantity(value: number) {
  return Number(value.toFixed(6)).toLocaleString('en-US', {
    maximumFractionDigits: 6,
    useGrouping: false,
  });
}

/** Latest commitment of a kind that counts, by recorded time then ID. */
function effective(
  commitments: Commitment[],
  lineId: string | null,
  kind: CommitmentKind,
) {
  return commitments
    .filter(
      (c) => c.lineId === lineId && c.kind === kind && c.status === 'confirmed',
    )
    .sort(
      (a, b) =>
        a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
    )
    .at(-1);
}

/**
 * Explains why a proposed commitment must be reviewed before it counts. Changes against the
 * order and anything uncertain need a person; matching confirmations do not.
 */
export function reviewReasons(
  fact: Pick<Commitment, 'kind' | 'quantity' | 'date' | 'lineId'>,
  line: PurchaseOrderLine | null,
  requestedDate: string | null,
  options: { confident: boolean; lineRequired: boolean },
): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (!options.confident) reasons.push('low_confidence');
  if (options.lineRequired && !line) reasons.push('unmatched_line');
  if (
    fact.kind === 'confirmed_quantity' &&
    line &&
    fact.quantity !== null &&
    Math.abs(fact.quantity - line.quantity) > 1e-9
  )
    reasons.push('quantity_changed');
  if (
    fact.kind === 'promised_date' &&
    fact.date &&
    requestedDate &&
    fact.date > requestedDate
  )
    reasons.push('date_later');
  if (fact.kind === 'condition') reasons.push('supplier_condition');

  return reasons;
}

/** Whether a confirmed commitment differs from what was ordered and needs acknowledgement. */
export function isMaterialChange(
  commitment: Commitment,
  line: PurchaseOrderLine | undefined,
  requestedDate: string | null,
) {
  if (commitment.status !== 'confirmed') return false;
  if (commitment.kind === 'confirmed_quantity' && line)
    return (
      commitment.quantity !== null &&
      Math.abs(commitment.quantity - line.quantity) > 1e-9
    );
  if (commitment.kind === 'promised_date')
    return (
      !!commitment.date && !!requestedDate && commitment.date > requestedDate
    );

  return commitment.kind === 'condition';
}

/**
 * Derives each line's progress, the four milestones, overdue work and the next owner from
 * persisted records. Receipt comes only from purchasing-system observations.
 */
export function orderProgress(input: {
  order: PurchaseOrder;
  submission: Submission | null;
  commitments: Commitment[];
  followUps: FollowUp[];
  terms: SupplierTerms;
  /** Whether replenishment independently verified this draft. */
  draftVerified: boolean;
  /** Whether the supplier is linked to a purchasing system. */
  supplierLinked: boolean;
  now: Date;
}): OrderProgress {
  const { order, submission, commitments, followUps, now } = input;
  const today = dateOnly(now.toISOString());
  const submitted = submission?.state === 'submitted';
  const cancelled = order.status === 'cancelled';
  const requestedDate = submission?.requestedDeliveryDate ?? null;
  const responded = new Map(followUps.map((f) => [f.key, f]));
  const lines: LineProgress[] = order.lines.map((line) => {
    const confirmed = effective(commitments, line.id, 'confirmed_quantity');
    const promised =
      effective(commitments, line.id, 'promised_date') ??
      effective(commitments, null, 'promised_date');
    const received = effective(commitments, line.id, 'received');
    const shipped =
      effective(commitments, line.id, 'shipped') ??
      effective(commitments, null, 'shipped');
    const receivedQuantity = received?.quantity ?? 0;
    const target = confirmed?.quantity ?? line.quantity;
    const outstanding = Math.max(0, target - receivedQuantity);
    // A requested date is an expectation only once the supplier has the order.
    const expectedDate = promised?.date ?? (submitted ? requestedDate : null);
    const changed =
      !!confirmed && Math.abs((confirmed.quantity ?? 0) - line.quantity) > 1e-9;
    const stage: LineStage = cancelled
      ? 'cancelled'
      : receivedQuantity > 0 && outstanding <= 1e-9
        ? 'received'
        : receivedQuantity > 0
          ? 'partially_received'
          : !submitted
            ? 'not_submitted'
            : changed ||
                (promised?.date &&
                  requestedDate &&
                  promised.date > requestedDate)
              ? 'changed'
              : confirmed || promised
                ? 'confirmed'
                : 'awaiting_confirmation';
    const dueDate = followUpDate(
      responded,
      `delivery_overdue:${order.id}:${line.id}:${expectedDate}`,
      expectedDate,
    );

    return {
      lineId: line.id,
      sku: line.sku,
      description: line.description,
      unit: line.unit,
      ordered: line.quantity,
      confirmed: confirmed?.quantity ?? null,
      confirmedSource: confirmed?.source.kind ?? null,
      promisedDate: promised?.date ?? null,
      requestedDate,
      expectedDate,
      received: receivedQuantity,
      receivedObservedAt:
        received?.source.kind === 'purchasing_system'
          ? received.source.observedAt
          : null,
      outstanding,
      shippedDate: shipped?.date ?? null,
      stage,
      overdue:
        submitted &&
        !cancelled &&
        outstanding > 1e-9 &&
        !!dueDate &&
        dueDate < today,
    };
  });

  const confirmationDueAt =
    submitted && submission.submittedAt
      ? new Date(
          Date.parse(submission.submittedAt) +
            input.terms.confirmationHours * 3_600_000,
        ).toISOString()
      : null;
  const anyConfirmed = lines.some(
    (l) => l.confirmed !== null || l.promisedDate !== null,
  );
  const allConfirmed = lines.every(
    (l) => l.confirmed !== null || l.stage === 'received',
  );
  const confirmationOverdue =
    submitted &&
    !cancelled &&
    !anyConfirmed &&
    lines.every((l) => l.received === 0) &&
    !!confirmationDueAt &&
    Date.parse(
      followUpDate(
        responded,
        `confirmation_overdue:${order.id}:${confirmationDueAt}`,
        confirmationDueAt,
      )!,
    ) < now.getTime();

  const attention: Attention[] = [];
  if (submission?.state === 'approval_required')
    attention.push({
      key: `submission_approval:${submission.id}`,
      kind: 'submission_approval',
      lineId: null,
      commitmentId: null,
      submissionId: submission.id,
      dueAt: submission.requestedAt,
      summary: `Approve sending ${order.reference} to the supplier`,
    });
  if (submission?.state === 'uncertain')
    attention.push({
      key: `submission_uncertain:${submission.id}`,
      kind: 'submission_uncertain',
      lineId: null,
      commitmentId: null,
      submissionId: submission.id,
      dueAt: submission.updatedAt,
      summary: `Check whether ${order.reference} reached the purchasing system`,
    });
  if (!cancelled) {
    for (const c of commitments.filter((c) => c.status === 'needs_review'))
      attention.push({
        key: `review_commitment:${c.id}`,
        kind: 'review_commitment',
        lineId: c.lineId,
        commitmentId: c.id,
        submissionId: null,
        dueAt: c.recordedAt,
        summary: `Review what the supplier said about ${order.reference}`,
      });
    const latestByLineKind = new Map<string, Commitment>();
    for (const c of commitments)
      if (c.status === 'confirmed' && c.kind !== 'received') {
        const key = `${c.lineId}:${c.kind}`;
        const prior = latestByLineKind.get(key);
        if (
          !prior ||
          prior.recordedAt.localeCompare(c.recordedAt) < 0 ||
          (prior.recordedAt === c.recordedAt && prior.id < c.id)
        )
          latestByLineKind.set(key, c);
      }
    for (const c of latestByLineKind.values()) {
      const line = order.lines.find((l) => l.id === c.lineId);
      const progress = lines.find((l) => l.lineId === c.lineId);
      if (progress?.stage === 'received') continue;
      const key = `commitment_changed:${c.id}`;
      if (!isMaterialChange(c, line, requestedDate) || responded.has(key))
        continue;
      attention.push({
        key,
        kind: 'commitment_changed',
        lineId: c.lineId,
        commitmentId: c.id,
        submissionId: null,
        dueAt: c.recordedAt,
        summary:
          c.kind === 'confirmed_quantity'
            ? `Supplier confirmed ${formatQuantity(c.quantity ?? 0)} of ${formatQuantity(line?.quantity ?? 0)} ${line?.unit ?? ''} on ${order.reference}`.trim()
            : c.kind === 'promised_date'
              ? `Supplier moved delivery of ${order.reference} to ${c.date}`
              : `Supplier added a condition to ${order.reference}`,
      });
    }
    if (confirmationOverdue)
      attention.push({
        key: `confirmation_overdue:${order.id}:${followUpDate(responded, `confirmation_overdue:${order.id}:${confirmationDueAt}`, confirmationDueAt)}`,
        kind: 'confirmation_overdue',
        lineId: null,
        commitmentId: null,
        submissionId: submission?.id ?? null,
        dueAt: confirmationDueAt!,
        summary: `${order.reference} has no supplier confirmation`,
      });
    for (const line of lines.filter((l) => l.overdue)) {
      const base = `delivery_overdue:${order.id}:${line.lineId}:${line.expectedDate}`;
      const due = followUpDate(responded, base, line.expectedDate)!;
      attention.push({
        key: due === line.expectedDate ? base : `${base}:${due}`,
        kind: 'delivery_overdue',
        lineId: line.lineId,
        commitmentId: null,
        submissionId: null,
        dueAt: `${due}T23:59:59.999Z`,
        summary: `${formatQuantity(line.outstanding)} ${line.unit} of ${line.sku} overdue on ${order.reference}`,
      });
    }
  }

  const receivedLines = lines.filter((l) => l.received > 0).length;
  const allReceived = lines.every((l) => l.stage === 'received');
  const submissionLabel: Record<SubmissionState, string> = {
    not_executed: 'Observe-only. Nothing was sent.',
    approval_required: 'Waiting for a second person to approve sending it.',
    approved: 'Approved. Luma is placing it in the purchasing system.',
    rejected: 'Sending was rejected.',
    expired: 'The approval request expired before it was sent.',
    submitting: 'Luma is placing it in the purchasing system.',
    uncertain:
      'The purchasing system did not confirm the request. Luma is checking whether it was created.',
    submitted: 'Found in the purchasing system by an independent read.',
    failed: 'The purchasing system did not create it.',
  };
  const lastReceipt = lines
    .map((l) => l.receivedObservedAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  const firstConfirmation = commitments
    .filter(
      (c) =>
        c.status === 'confirmed' &&
        (c.kind === 'confirmed_quantity' || c.kind === 'promised_date'),
    )
    .map((c) => c.recordedAt)
    .sort()[0];
  const milestones: Milestone[] = [
    {
      key: 'drafted',
      state: 'complete',
      at: order.createdAt,
      evidence: input.draftVerified
        ? 'Draft created by replenishment and independently verified.'
        : order.origin.workflowRunId
          ? 'Draft created by replenishment. Verification is not recorded.'
          : 'Draft recorded in Luma.',
    },
    {
      key: 'submitted',
      state:
        cancelled && !submitted
          ? 'stopped'
          : !submission
            ? 'not_started'
            : submission.state === 'submitted'
              ? 'complete'
              : ['uncertain', 'failed', 'rejected', 'expired'].includes(
                    submission.state,
                  )
                ? 'attention'
                : 'in_progress',
      at: submission?.submittedAt ?? submission?.requestedAt ?? null,
      evidence: submission
        ? submissionLabel[submission.state]
        : order.authority === 'external'
          ? 'Managed in an external system.'
          : input.supplierLinked
            ? 'Not sent to the supplier yet.'
            : 'Not sent. Link the supplier to a purchasing system to send it from Luma.',
    },
    {
      key: 'confirmed',
      state: !submitted
        ? cancelled
          ? 'stopped'
          : 'not_started'
        : confirmationOverdue ||
            attention.some(
              (a) =>
                a.kind === 'commitment_changed' ||
                a.kind === 'review_commitment',
            )
          ? 'attention'
          : allConfirmed
            ? 'complete'
            : anyConfirmed
              ? 'partial'
              : 'pending',
      at: firstConfirmation ?? null,
      evidence: !submitted
        ? 'Waits for the order to reach the supplier.'
        : confirmationOverdue
          ? 'The confirmation deadline passed without a supplier confirmation.'
          : allConfirmed
            ? lines.some(
                (l) =>
                  (l.confirmed !== null &&
                    Math.abs(l.confirmed - l.ordered) > 1e-9) ||
                  (!!l.promisedDate &&
                    !!l.requestedDate &&
                    l.promisedDate > l.requestedDate),
              )
              ? 'Confirmed with changes to quantity or date.'
              : 'All lines confirmed as ordered.'
            : anyConfirmed
              ? `${plural(lines.filter((l) => l.confirmed !== null).length, 'line')} of ${lines.length} confirmed.`
              : confirmationDueAt
                ? 'Waiting for the supplier to confirm.'
                : 'Waiting for the supplier to confirm.',
    },
    {
      key: 'received',
      state: !submitted
        ? cancelled
          ? 'stopped'
          : 'not_started'
        : allReceived
          ? 'complete'
          : lines.some((l) => l.overdue)
            ? 'attention'
            : receivedLines
              ? 'partial'
              : 'pending',
      at: lastReceipt ?? null,
      evidence: !submitted
        ? 'Receipt is read from the purchasing system after the order is sent.'
        : allReceived
          ? 'All units booked as received in the purchasing system.'
          : receivedLines
            ? `${plural(receivedLines, 'line')} partly or fully booked as received.`
            : 'No goods receipt booked in the purchasing system yet.',
    },
  ];

  const outstandingLines = lines.filter(
    (l) => l.outstanding > 1e-9 && l.stage !== 'cancelled',
  );
  const expectedDate =
    outstandingLines
      .map((l) => l.expectedDate)
      .filter((d): d is string => !!d)
      .sort()[0] ?? null;

  return {
    milestones,
    lines,
    expectedDate,
    confirmationDueAt,
    attention: attention.sort(
      (a, b) => a.dueAt.localeCompare(b.dueAt) || a.key.localeCompare(b.key),
    ),
    next: nextAction({
      order,
      submission,
      attention,
      lines,
      allReceived,
      supplierLinked: input.supplierLinked,
      expectedDate,
      confirmationDueAt,
    }),
  };
}

function followUpDate(
  responded: Map<string, FollowUp>,
  key: string,
  due: string | null,
): string | null {
  let current = due;
  let response = responded.get(key);
  // Each follow-up moves the check date; a later follow-up answers the moved date.
  for (let i = 0; response?.nextCheckAt && i < 20; i++) {
    current =
      due && due.length === 10
        ? dateOnly(response.nextCheckAt)
        : response.nextCheckAt;
    response = responded.get(`${key}:${current}`);
  }

  return current;
}

function nextAction(input: {
  order: PurchaseOrder;
  submission: Submission | null;
  attention: Attention[];
  lines: LineProgress[];
  allReceived: boolean;
  supplierLinked: boolean;
  expectedDate: string | null;
  confirmationDueAt: string | null;
}): NextAction {
  const { order, submission, attention, lines } = input;
  if (order.status === 'cancelled')
    return {
      owner: 'none',
      title: 'Cancelled',
      detail:
        submission?.state === 'submitted'
          ? 'Cancelled in Luma only. Cancel it in the purchasing system and tell the supplier if goods should not arrive.'
          : 'No further action.',
    };
  if (order.status === 'closed')
    return { owner: 'none', title: 'Closed', detail: 'No further action.' };
  if (order.authority === 'external')
    return {
      owner: 'buyer',
      title: 'Follow it in the external system',
      detail: 'Luma does not track this order’s supplier lifecycle.',
    };
  if (submission?.state === 'not_executed')
    return {
      owner: 'none',
      title: 'Observe-only',
      detail:
        'Would run when writes are enabled. Request a fresh proposal after enabling writes.',
    };
  const first = attention[0];
  if (first?.kind === 'submission_approval')
    return {
      owner: 'approver',
      title: 'Approve sending the order',
      detail:
        'Someone else who can approve changes must approve before Luma places it in the purchasing system.',
    };
  if (first?.kind === 'submission_uncertain')
    return {
      owner: 'luma',
      title: 'Checking the purchasing system',
      detail:
        'The request may have been created. Luma will not send it again until a read settles the result.',
    };
  if (first?.kind === 'review_commitment')
    return {
      owner: 'buyer',
      title: 'Review supplier message',
      detail: 'Check the highlighted facts before they count as commitments.',
    };
  if (first?.kind === 'commitment_changed')
    return {
      owner: 'buyer',
      title: 'Accept or follow up on a change',
      detail:
        'The supplier’s commitment differs from the order. Accept it so it becomes what Luma expects, or record a follow-up with the supplier.',
    };
  if (first?.kind === 'confirmation_overdue')
    return {
      owner: 'buyer',
      title: 'Chase the supplier for a confirmation',
      detail:
        'The agreed confirmation time has passed. Luma can’t contact the supplier; record what you did and when to check again.',
    };
  if (first?.kind === 'delivery_overdue')
    return {
      owner: 'buyer',
      title: 'Chase the overdue delivery',
      detail:
        'Committed units are not booked as received by their expected date. Record what you did and when to check again.',
    };
  if (
    !submission ||
    ['rejected', 'expired', 'failed'].includes(submission.state)
  )
    return input.supplierLinked
      ? {
          owner: 'buyer',
          title: submission
            ? 'Send the order again'
            : 'Send the order to the supplier',
          detail:
            'Review lines and the requested date, then request approval to place it in the purchasing system.',
        }
      : {
          owner: 'buyer',
          title: 'Send the order to the supplier',
          detail:
            'Link the supplier to its purchasing-system record, or send the order outside Luma and record the supplier’s reply here.',
        };
  if (submission.state !== 'submitted')
    return {
      owner: 'luma',
      title: 'Placing the order',
      detail:
        'Luma is creating the order in the purchasing system and will verify it with a separate read.',
    };
  if (input.allReceived)
    return {
      owner: 'buyer',
      title: 'Close the order',
      detail: 'All units are booked as received.',
    };
  if (lines.every((l) => l.confirmed === null && l.promisedDate === null))
    return {
      owner: 'supplier',
      title: 'Waiting for supplier confirmation',
      detail: input.confirmationDueAt
        ? `Expected by ${input.confirmationDueAt.slice(0, 16).replace('T', ' ')} UTC.`
        : 'Expected soon.',
    };

  return {
    owner: 'warehouse',
    title: 'Waiting for goods receipt',
    detail: input.expectedDate
      ? `Expected on ${input.expectedDate}. Receipt is booked in the purchasing system.`
      : 'Receipt is booked in the purchasing system.',
  };
}

/** A supplier message captured for an order. Text is removed after its retention period. */
export interface Communication {
  id: string;
  tenantId: string;
  supplierId: string;
  purchaseOrderId: string | null;
  channel: 'email' | 'portal' | 'phone' | 'other';
  from: string;
  /** Null once the text was removed. */
  subject: string | null;
  body: string | null;
  receivedAt: string;
  /** The sender's message ID, when the channel provides one. */
  messageId: string | null;
  /** SHA-256 of sender, subject and text; retained after the text is removed. */
  digest: string;
  capturedBy: string;
  capturedAt: string;
  retainUntil: string;
  purgedAt?: string | undefined;
  purgeReason?: 'retention' | 'request' | undefined;
}

/** One attempt to read commitments from a message. */
export interface Extraction {
  id: string;
  tenantId: string;
  communicationId: string;
  attempt: number;
  state: 'completed' | 'unavailable' | 'failed';
  /** Whether the model judged the message to be about the order. */
  relatesToOrder: boolean | null;
  /** IDs of commitments created from this attempt. */
  commitmentIds: string[];
  discarded: number;
  model: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: string;
}

/** A read of the purchasing-system order, kept as evidence. */
export interface PurchasingObservation {
  id: string;
  tenantId: string;
  purchaseOrderId: string;
  submissionId: string;
  connectionId: string;
  externalId: string;
  observedAt: string;
  digest: string;
  status: string;
  orderNumber: string | null;
  confirmed: boolean | null;
  lines: {
    lineId: string | null;
    externalLineId: string;
    quantity: string;
    deliveredQuantity: string | null;
    confirmedQuantity: string | null;
    confirmedDeliveryDate: string | null;
    confirmed: boolean | null;
  }[];
}

/** Purchase-order stages for lists and filters, from the most specific evidence available. */
export type OrderStage =
  | 'draft'
  | 'awaiting_approval'
  | 'sending'
  | 'send_failed'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'changed'
  | 'partially_received'
  | 'received'
  | 'closed'
  | 'cancelled';

/** Summarizes progress into one stage. */
export function orderStage(
  order: Pick<PurchaseOrder, 'status'>,
  submission: Submission | null,
  progress: Pick<OrderProgress, 'lines'>,
): OrderStage {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'closed') return 'closed';
  if (!submission || submission.state === 'not_executed') return 'draft';
  if (submission.state === 'approval_required') return 'awaiting_approval';
  if (['approved', 'submitting', 'uncertain'].includes(submission.state))
    return 'sending';
  if (['failed', 'rejected', 'expired'].includes(submission.state))
    return 'send_failed';
  const lines = progress.lines;
  if (lines.every((l) => l.stage === 'received')) return 'received';
  if (lines.some((l) => l.received > 0)) return 'partially_received';
  if (lines.some((l) => l.stage === 'changed')) return 'changed';
  if (lines.some((l) => l.stage === 'confirmed')) return 'confirmed';

  return 'awaiting_confirmation';
}
