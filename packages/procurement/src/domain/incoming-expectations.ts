import {
  type Commitment,
  defaultSupplierTerms,
  type FollowUp,
  orderProgress,
  type Submission,
} from './commitments.js';
import type { PurchaseOrder } from './procurement.js';

/** What the supplier is still expected to deliver on one order line, with its evidence time. */
export interface IncomingLineExpectation {
  expectedQuantity: number;
  providerReceivedQuantity: number;
  observedAt: string;
  expectedDate: string | null;
  dateConfidence: 'confirmed' | 'requested' | 'unknown';
}

/**
 * Whether a submission settles what is expected from the supplier. A submitted order counts only
 * with persisted independent proof (the purchasing order read, or the mail's accepted message
 * id); failed, rejected and expired submissions clear expectations. Anything else is still open.
 */
export function incomingSubmissionSettled(submission: Submission) {
  if (submission.state === 'submitted')
    return submission.channel === 'email'
      ? !!submission.outgoing?.sentMessageId
      : !!submission.externalOrder;

  return ['failed', 'rejected', 'expired'].includes(submission.state);
}

/**
 * Expected deliveries per order line, keyed by line id. Expectations exist only for a submitted,
 * open order: the confirmed (or ordered) quantity less a shortage the buyer accepted, credited or
 * wrote off. Provider receipts are reported separately; they never reduce the expectation here.
 */
export function incomingLineExpectations(input: {
  order: PurchaseOrder;
  submission: Submission;
  commitments: Commitment[];
  followUps: FollowUp[];
  now: Date;
}): Map<string, IncomingLineExpectation> {
  const { order, submission, commitments, followUps } = input;
  const progress = orderProgress({
    order,
    submission,
    commitments,
    followUps,
    terms: defaultSupplierTerms,
    draftVerified: false,
    supplierLinked: false,
    now: input.now,
  });
  const expectations = new Map<string, IncomingLineExpectation>();
  for (const line of order.lines) {
    const lineProgress = progress.lines.find(
      (value) => value.lineId === line.id,
    )!;
    const shortage = commitments
      .filter(
        (value) =>
          value.lineId === line.id &&
          value.kind === 'shortage' &&
          value.status === 'confirmed',
      )
      .at(-1);
    const disposition = shortage
      ? followUps
          .filter(
            (value) =>
              value.key === `receipt_difference:${shortage.id}` ||
              value.key.startsWith(`receipt_difference:${shortage.id}:`),
          )
          .at(-1)
      : null;
    const settled =
      disposition &&
      ['accepted', 'credited', 'written_off'].includes(disposition.response)
        ? (shortage?.quantity ?? 0)
        : 0;
    const providerReceived =
      commitments
        .filter(
          (value) =>
            value.lineId === line.id &&
            value.kind === 'received' &&
            value.status === 'confirmed' &&
            value.source.kind === 'purchasing_system',
        )
        .at(-1)?.quantity ?? 0;
    const expectedQuantity =
      submission.state === 'submitted' && order.status === 'open'
        ? Math.max(0, (lineProgress.confirmed ?? line.quantity) - settled)
        : 0;
    const observedAt =
      commitments
        .filter(
          (value) =>
            value.status === 'confirmed' &&
            (value.lineId === line.id || value.lineId === null),
        )
        .map((value) =>
          value.source.kind === 'purchasing_system'
            ? value.source.observedAt
            : value.recordedAt,
        )
        .sort()
        .at(-1) ??
      submission.submittedAt ??
      submission.updatedAt;
    expectations.set(line.id, {
      expectedQuantity,
      providerReceivedQuantity: providerReceived,
      observedAt,
      expectedDate: lineProgress.expectedDate,
      dateConfidence: lineProgress.promisedDate
        ? 'confirmed'
        : lineProgress.requestedDate
          ? 'requested'
          : 'unknown',
    });
  }

  return expectations;
}
