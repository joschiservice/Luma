import type { ReturnCase } from './return-cases.js';

/** Merchant-reviewed deadlines; absent configuration never creates an inferred due date. */
export interface ReturnDeadlinePolicy {
  revision: number;
  enabled: boolean;
  receiptHours: number;
  inspectionHours: number;
  financialHours: number;
  sourceMaxAgeSeconds: number;
  updatedBy: string;
  updatedAt: string;
}

export type ReturnWaitPhase =
  'receipt' | 'inspection' | 'proposal' | 'financial';

type ReturnWaitReason =
  | 'missing_units'
  | 'inspection'
  | 'proposal'
  | 'not_requested'
  | 'pending_money'
  | 'failed_money'
  | 'partial_money'
  | 'missing_evidence'
  | 'stale_evidence'
  | 'unavailable_evidence';

/** One durable waiting occurrence. Superseded and paused entries make no claim of resolution. */
export interface ReturnWaitEpisode {
  id: string;
  tenantId: string;
  caseId: string;
  orderId: string;
  connectionId: string;
  phase: ReturnWaitPhase;
  anchorAt: string;
  anchorOrigin:
    | 'case_opened'
    | 'receipt_recorded'
    | 'inspection_recorded'
    | 'resolution_proposed'
    | 'action_requested';
  policyRevision: number;
  occurrence: number;
  dueAt: string;
  state: 'waiting' | 'escalated' | 'verified' | 'superseded' | 'paused';
  reason: ReturnWaitReason;
  ownerId: string;
  units: number | null;
  observedAt: string | null;
  evidenceRefs: string[];
  openedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** Financial evidence is independently read, scoped and complete; accepted writes are not money. */
export interface ReturnMoneyEvidence {
  state:
    | 'not_requested'
    | 'pending'
    | 'failed'
    | 'partial'
    | 'paid'
    | 'not_required'
    | 'unknown';
  observedAt: string | null;
  evidenceRefs: string[];
  readable: boolean;
  complete: boolean;
  requestedAt: string | null;
}

export interface ReturnWaitingCondition {
  phase: ReturnWaitPhase;
  anchorAt: string;
  anchorOrigin: ReturnWaitEpisode['anchorOrigin'];
  dueAt: string;
  reason: ReturnWaitReason;
  units: number | null;
  observedAt: string | null;
  evidenceRefs: string[];
}

/** Separates operator receipt/inspection from source financial evidence without inventing event times. */
export function returnWaitingConditions(
  value: ReturnCase,
  policy: ReturnDeadlinePolicy,
  money: ReturnMoneyEvidence,
  now: Date,
): { conditions: ReturnWaitingCondition[]; verified: ReturnWaitPhase[] } {
  if (!policy.enabled || value.state !== 'open')
    return { conditions: [], verified: [] };
  const conditions: ReturnWaitingCondition[] = [],
    verified: ReturnWaitPhase[] = [];
  const add = (
    phase: ReturnWaitPhase,
    anchorAt: string,
    anchorOrigin: ReturnWaitEpisode['anchorOrigin'],
    hours: number,
    reason: ReturnWaitReason,
    units: number | null,
    observedAt: string | null,
    evidenceRefs: string[],
  ) => {
    conditions.push({
      phase,
      anchorAt,
      anchorOrigin,
      dueAt: new Date(Date.parse(anchorAt) + hours * 3_600_000).toISOString(),
      reason,
      units,
      observedAt,
      evidenceRefs,
    });
  };
  const received =
    value.receipt?.lines.reduce((n, l) => n + l.received, 0) ?? 0;
  const requested = value.lines.reduce((n, l) => n + l.quantity, 0);
  if (received < requested)
    add(
      'receipt',
      value.openedAt,
      'case_opened',
      policy.receiptHours,
      'missing_units',
      requested - received,
      value.receipt?.at ?? null,
      [`case:${value.id}:${value.revision}`],
    );
  else verified.push('receipt');
  if (received > 0 && !value.inspection)
    add(
      'inspection',
      value.receipt!.at,
      'receipt_recorded',
      policy.inspectionHours,
      'inspection',
      received,
      value.receipt!.at,
      [`case:${value.id}:${value.revision}`],
    );
  else if (value.inspection) verified.push('inspection');
  if (value.inspection && !value.proposal)
    add(
      'proposal',
      value.inspection.at,
      'inspection_recorded',
      policy.inspectionHours,
      'proposal',
      received,
      value.inspection.at,
      [`case:${value.id}:${value.revision}`],
    );
  else if (value.proposal) verified.push('proposal');
  if (
    received > 0 &&
    value.proposal &&
    ['refund', 'exchange'].includes(value.proposal.kind)
  ) {
    const fresh =
      money.readable &&
      money.complete &&
      money.observedAt !== null &&
      money.evidenceRefs.length > 0 &&
      Date.parse(money.observedAt) >=
        Date.parse(money.requestedAt ?? value.proposal.at) &&
      Date.parse(money.observedAt) <= +now &&
      +now - Date.parse(money.observedAt) <= policy.sourceMaxAgeSeconds * 1000;
    if (fresh && ['paid', 'not_required'].includes(money.state))
      verified.push('financial');
    else {
      const reason: ReturnWaitReason = !money.readable
        ? 'unavailable_evidence'
        : money.state === 'not_requested'
          ? 'not_requested'
          : !money.complete || !money.observedAt || !money.evidenceRefs.length
            ? 'missing_evidence'
            : !fresh
              ? 'stale_evidence'
              : money.state === 'pending'
                ? 'pending_money'
                : money.state === 'failed'
                  ? 'failed_money'
                  : money.state === 'partial'
                    ? 'partial_money'
                    : 'missing_evidence';
      add(
        'financial',
        money.requestedAt ?? value.proposal.at,
        money.requestedAt ? 'action_requested' : 'resolution_proposed',
        policy.financialHours,
        reason,
        null,
        money.observedAt,
        money.evidenceRefs,
      );
    }
  }

  return { conditions, verified };
}
