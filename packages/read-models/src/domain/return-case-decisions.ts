import type { DecisionCandidate } from './decision-item.js';

/** Presents owned return work without turning a proposal or provider acceptance into completion. */
export function presentReturnCase(item: {
  case: {
    id: string;
    orderId: string;
    orderNumber: string | null;
    units: number;
    stage: string;
    openedAt: string;
    updatedAt: string;
    revision?: number;
  };
  creation: {
    id?: string;
    state: string;
    expiresAt: string;
    requestedAt: string;
    requestedBy: { id: string };
    canApprove: boolean;
    canSend: boolean;
    observeOnly: boolean;
  } | null;
  assignment: {
    assigneeId: string;
    assignedBy: string;
    assignedAt: string;
    revision: number;
  } | null;
  canManage: boolean;
  completion?: {
    state: string;
    ownerId: string;
    checkedAt: string;
    checks: { id: string; verified: boolean }[];
  };
  waiting?: {
    dueAt: string;
    reason: string;
    observedAt: string | null;
    ownerId: string;
  };
}): DecisionCandidate {
  const { case: value, creation } = item;
  const approval = creation?.state === 'approval_required';
  const uncertain =
    creation?.state === 'uncertain' || creation?.state === 'sending';
  const run = creation?.state === 'approved';

  return {
    id: `return-case:${value.id}`,
    ...(creation?.id
      ? { actionReference: { runId: creation.id, stepId: 'create' } }
      : {}),
    kind: 'return_case',
    domain: 'orders',
    reason: approval
      ? 'approval'
      : uncertain
        ? 'uncertainty'
        : run
          ? 'run'
          : 'manual_intervention',
    title: value.orderNumber ?? value.id,
    why: approval
      ? 'The return action needs an independent approval.'
      : uncertain
        ? 'The return action is unconfirmed. Check the source before taking another action.'
        : item.completion?.state === 'unresolved'
          ? `Exchange consistency needs its owner: ${item.completion.checks
              .filter((c) => !c.verified)
              .map((c) => c.id)
              .join(', ')}.`
          : item.waiting
            ? `Return progress needs its owner: ${item.waiting.reason.replaceAll('_', ' ')}.`
            : 'The return needs receipt, inspection or settlement by its owner.',
    consequences: [
      {
        response: 'Open return case',
        text: 'Review source evidence and continue the case. A proposal changes nothing in the connected systems.',
      },
    ],
    change: [
      { label: 'Units', value: String(value.units) },
      { label: 'Stage', value: value.stage },
      ...(item.completion?.state === 'unresolved'
        ? [{ label: 'Exchange completion', value: 'unresolved' }]
        : []),
    ],
    impact: { level: 'unknown', text: null },
    requestedAt: creation?.requestedAt ?? value.openedAt,
    deadline: approval ? creation.expiresAt : (item.waiting?.dueAt ?? null),
    requesterId: creation?.requestedBy.id ?? null,
    evidence: {
      observedAt:
        item.completion?.checkedAt ??
        item.waiting?.observedAt ??
        value.updatedAt,
      validUntil: approval ? creation.expiresAt : null,
    },
    response: !item.canManage
      ? 'view_only'
      : approval
        ? creation.canApprove
          ? 'decide'
          : 'awaiting_other'
        : run
          ? creation.canSend
            ? 'run'
            : 'awaiting_other'
          : uncertain
            ? 'check'
            : 'investigate',
    ...(item.assignment
      ? { ownerAssignment: item.assignment }
      : item.completion?.state === 'unresolved'
        ? {
            ownerAssignment: {
              assigneeId: item.completion.ownerId,
              assignedBy: item.completion.ownerId,
              assignedAt: value.openedAt,
              revision: value.revision ?? 0,
            },
          }
        : item.waiting
          ? {
              ownerAssignment: {
                assigneeId: item.waiting.ownerId,
                assignedBy: item.waiting.ownerId,
                assignedAt: value.openedAt,
                revision: value.revision ?? 0,
              },
            }
          : {}),
    subject: { label: value.orderNumber ?? value.id, detail: null },
    record: { kind: 'order', id: value.orderId },
    owner: { kind: 'return_case', caseId: value.id },
    // A creation cites the reads and receipt of its write; other return work cites none yet.
    ...(creation?.id
      ? {
          citedEvidence: {
            subject: { kind: 'return_creation' as const, id: creation.id },
          },
        }
      : {}),
    group: { key: 'return-cases', label: 'Returns' },
    ...(creation?.observeOnly ? { observeOnly: true } : {}),
  };
}
