import type {
  Commitment,
  Communication,
  FollowUp,
  Submission,
} from './commitments.js';
import type { PurchaseOrder } from './procurement.js';

/** Evidence-backed purchasing history. Recorded facts, provider acceptance and independent verification stay distinct. */
export interface PurchasingTimelineEntry {
  id: string;
  kind:
    | 'draft'
    | 'lifecycle'
    | 'submission'
    | 'supplier_message'
    | 'commitment'
    | 'follow_up'
    | 'revision'
    | 'stock_booking';
  stage:
    | 'recorded'
    | 'approval_required'
    | 'approved'
    | 'rejected'
    | 'sending'
    | 'sent'
    | 'observed'
    | 'uncertain'
    | 'failed'
    | 'verified';
  at: string;
  actorId: string | null;
  actor?:
    | {
        kind: 'member' | 'former_member' | 'luma' | 'unrecorded';
        id: string | null;
        name: string | null;
        email: string | null;
        workflow: { id: string; name: string | null } | null;
      }
    | undefined;
  reason: string | null;
  evidenceRefs: string[];
  quantity: number | null;
  unit: string | null;
  revision: number | null;
  detail: string | null;
  source: 'luma' | 'manual' | 'purchasing_system' | 'email' | 'inventory';
}

/** Combines append-only supplier facts and recorded lifecycle events with independently sourced action history. */
export function purchasingTimeline(input: {
  order: PurchaseOrder;
  history: {
    id: string;
    occurredAt: string;
    actorId: string;
    reason: string;
    revision: number;
    from: PurchaseOrder['status'] | null;
    to: PurchaseOrder['status'];
  }[];
  submissions: Submission[];
  commitments: Commitment[];
  communications: Communication[];
  followUps: FollowUp[];
  extra: PurchasingTimelineEntry[];
}) {
  const entries: PurchasingTimelineEntry[] = [...input.extra];
  const add = (
    entry: Pick<
      PurchasingTimelineEntry,
      'id' | 'kind' | 'stage' | 'at' | 'source'
    > &
      Partial<
        Omit<PurchasingTimelineEntry, 'id' | 'kind' | 'stage' | 'at' | 'source'>
      >,
  ) =>
    entries.push({
      actorId: null,
      reason: null,
      evidenceRefs: [],
      quantity: null,
      unit: null,
      revision: null,
      detail: null,
      ...entry,
    });
  for (const event of input.history)
    add({
      id: `lifecycle:${event.id}`,
      kind: 'lifecycle',
      stage: 'recorded',
      at: event.occurredAt,
      source: 'luma',
      actorId: event.actorId,
      reason: event.reason || null,
      evidenceRefs: [event.id],
      revision: event.revision,
      detail: event.from ? `${event.from}->${event.to}` : 'created',
    });
  for (const submission of input.submissions) {
    const source =
      submission.channel === 'email' ? 'email' : 'purchasing_system';
    add({
      id: `submission:${submission.id}:requested`,
      kind: 'submission',
      stage: 'recorded',
      at: submission.requestedAt,
      source,
      actorId: submission.requestedBy,
      evidenceRefs: [submission.id],
      quantity: submission.lines.reduce((sum, line) => sum + line.quantity, 0),
      detail: 'requested',
    });
    if (
      submission.decidedAt &&
      submission.decidedBy &&
      !input.extra.some(
        (entry) =>
          entry.evidenceRefs.includes(submission.id) &&
          ['approved', 'rejected'].includes(entry.stage),
      )
    )
      add({
        id: `submission:${submission.id}:decision`,
        kind: 'submission',
        stage: submission.state === 'rejected' ? 'rejected' : 'approved',
        at: submission.decidedAt,
        source,
        actorId: submission.decidedBy,
        evidenceRefs: submission.decisionId ? [submission.decisionId] : [],
      });
    if (submission.channel === 'email' && submission.outgoing?.sentMessageId)
      add({
        id: `submission:${submission.id}:sent`,
        kind: 'submission',
        stage: 'sent',
        at: submission.submittedAt ?? submission.updatedAt,
        source,
        evidenceRefs: [submission.outgoing.sentMessageId],
      });
    else if (
      submission.submittedAt &&
      submission.externalOrder &&
      !input.extra.some(
        (entry) => entry.id === `submission:${submission.id}:verified`,
      )
    )
      add({
        id: `submission:${submission.id}:verified`,
        kind: 'submission',
        stage: 'verified',
        at: submission.submittedAt,
        source,
        // The purchasing system's order number is shown on the order, not cited as evidence.
        evidenceRefs: [submission.id],
      });
    else if (
      ['submitting', 'uncertain', 'failed', 'not_executed', 'expired'].includes(
        submission.state,
      )
    )
      add({
        id: `submission:${submission.id}:state`,
        kind: 'submission',
        stage:
          submission.state === 'submitting'
            ? 'sending'
            : submission.state === 'uncertain'
              ? 'uncertain'
              : 'failed',
        at: submission.updatedAt,
        source,
        reason: submission.failure,
        detail: submission.state,
      });
  }
  for (const message of input.communications)
    add({
      id: `message:${message.id}`,
      kind: 'supplier_message',
      stage: 'recorded',
      at: message.receivedAt,
      source: message.channel === 'email' ? 'email' : 'manual',
      actorId: message.capturedBy,
      detail: message.subject,
      evidenceRefs: [message.id],
    });
  for (const fact of input.commitments) {
    const observed = fact.source.kind === 'purchasing_system';
    const evidenceRefs =
      fact.source.kind === 'purchasing_system'
        ? [fact.source.observationId]
        : fact.source.kind === 'communication'
          ? [fact.source.communicationId]
          : fact.source.kind === 'manual_receipt'
            ? fact.source.evidence
            : [fact.id];
    add({
      id: `commitment:${fact.id}`,
      kind: 'commitment',
      stage: observed ? 'observed' : 'recorded',
      at: fact.recordedAt,
      source: observed
        ? 'purchasing_system'
        : fact.source.kind === 'communication' &&
            input.communications.find(
              (message) =>
                message.id ===
                (fact.source.kind === 'communication'
                  ? fact.source.communicationId
                  : ''),
            )?.channel === 'email'
          ? 'email'
          : 'manual',
      actorId: fact.recordedBy.kind === 'user' ? fact.recordedBy.id : null,
      evidenceRefs,
      quantity: fact.quantity,
      unit:
        input.order.lines.find((line) => line.id === fact.lineId)?.unit ?? null,
      revision: fact.orderRevision ?? null,
      detail: fact.kind,
      reason:
        fact.source.kind === 'manual_receipt' ||
        fact.source.kind === 'correction'
          ? fact.source.reason
          : fact.text,
    });
    if (fact.review)
      add({
        id: `commitment:${fact.id}:review`,
        kind: 'commitment',
        stage: fact.review.outcome === 'confirmed' ? 'approved' : 'rejected',
        at: fact.review.at,
        source: 'manual',
        actorId: fact.review.by,
        evidenceRefs: [fact.id],
        revision: fact.orderRevision ?? null,
        detail: fact.kind,
      });
  }
  for (const followUp of input.followUps)
    add({
      id: `follow-up:${followUp.id}`,
      kind: 'follow_up',
      stage: 'recorded',
      at: followUp.respondedAt,
      source: 'manual',
      actorId: followUp.respondedBy,
      reason: followUp.note,
      evidenceRefs: [followUp.id],
      detail: followUp.response,
    });
  const unique = [
    ...new Map(entries.map((entry) => [entry.id, entry])).values(),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  return { entries: unique.slice(-500), complete: unique.length <= 500 };
}

/** A successful dispatch is insufficient; verification must independently pass with concrete observations. */
export function purchasingExecutionVerified(attempt: {
  businessOutcome?: string | undefined;
  verification?: { outcome: string; observationRefs: string[] } | undefined;
}) {
  return (
    attempt.businessOutcome === 'satisfied' &&
    attempt.verification?.outcome === 'passed' &&
    attempt.verification.observationRefs.length > 0
  );
}
