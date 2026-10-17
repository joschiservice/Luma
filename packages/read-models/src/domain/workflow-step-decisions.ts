import type { DecisionCandidate } from './decision-item.js';

/** A workflow's proposed custom field change, as the adaptive owner reports it. */
export interface CustomFieldDecision {
  runId: string;
  stepId: string;
  field: { id: string; label: { en: string } };
  recordType: string;
  recordId: string;
  beforeValue: unknown;
  proposedValue: unknown;
  requesterId: string;
  requestedAt: string;
  expiresAt: string;
  canRespond: boolean;
  requireIndependentApproval: boolean;
  /** The field or value changed after the proposal; it can't be approved as it stands. */
  stale: boolean;
}

/** An open workflow task that waits for a person's answer, as the workflow owner reports it. */
export interface HumanTaskDecision {
  runId: string;
  stepId: string;
  definitionId: string;
  subject: { kind: string; id: string };
  instructions: string;
  evidence: string;
  dueAt: string;
  createdAt: string;
  escalatedAt: string | null;
}

/**
 * Presents a custom field change for approval. A stale proposal, or one the reader requested
 * when another person must approve it, can only be viewed.
 */
export function presentCustomFieldChange(
  item: CustomFieldDecision,
  readerId: string,
): DecisionCandidate {
  return {
    id: `custom-field:${item.runId}:${item.stepId}`,
    actionReference: { runId: item.runId, stepId: item.stepId },
    kind: 'custom_field',
    reason: 'approval',
    domain:
      item.recordType === 'order'
        ? 'orders'
        : item.recordType === 'product'
          ? 'inventory'
          : 'procurement',
    title: `Change ${item.field.label.en}`,
    why: item.stale
      ? 'The field or value changed after this proposal. Review the workflow again.'
      : 'A workflow proposes a typed custom field change.',
    consequences: [
      {
        response: 'Approve',
        text: 'The workflow may execute this exact change after current permissions and policy are checked.',
      },
      {
        response: 'Reject',
        text: 'The workflow cannot execute this proposed change.',
      },
    ],
    change: [
      { label: 'Before', value: JSON.stringify(item.beforeValue) },
      { label: 'After', value: JSON.stringify(item.proposedValue) },
    ],
    impact: { level: 'medium', text: null },
    requestedAt: item.requestedAt,
    deadline: item.expiresAt,
    requesterId: item.requesterId,
    evidence: { observedAt: item.requestedAt, validUntil: item.expiresAt },
    response:
      item.canRespond && !item.stale
        ? 'decide'
        : item.requireIndependentApproval && item.requesterId === readerId
          ? 'awaiting_other'
          : 'view_only',
    subject: { label: item.field.label.en, detail: item.recordId },
    record:
      item.recordType === 'order'
        ? { kind: 'order', id: item.recordId }
        : item.recordType === 'product'
          ? { kind: 'sku', id: item.recordId }
          : null,
    owner: { kind: 'custom_field', runId: item.runId, stepId: item.stepId },
    group: {
      key: `custom-field:${item.field.id}`,
      label: item.field.label.en,
    },
  };
}

/** Presents a task the reader answers to resume its workflow; the reader owns it. */
export function presentHumanTask(
  task: HumanTaskDecision,
  readerId: string,
): DecisionCandidate {
  return {
    id: `human-task:${task.runId}:${task.stepId}`,
    kind: 'human_task',
    reason: 'manual_intervention',
    domain: 'operations',
    title: task.instructions,
    why: task.escalatedAt
      ? 'The task is overdue and has been assigned to its fallback.'
      : 'A workflow needs your answer and evidence to continue.',
    consequences: [
      {
        response: 'Answer',
        text: 'Record your answer and resume the workflow. Provider changes still require policy admission.',
      },
    ],
    change: [{ label: 'Evidence', value: task.evidence }],
    impact: { level: 'unknown', text: null },
    requestedAt: task.createdAt,
    deadline: task.dueAt,
    requesterId: null,
    evidence: { observedAt: null, validUntil: null },
    response: 'investigate',
    ownerAssignment: {
      assigneeId: readerId,
      assignedBy: readerId,
      assignedAt: task.createdAt,
      revision: 0,
    },
    subject: { label: task.subject.kind, detail: task.subject.id },
    // An order task links to the order, where its change plan shows what to do.
    record:
      task.subject.kind === 'order'
        ? { kind: 'order', id: task.subject.id }
        : null,
    owner: {
      kind: 'human_task',
      definitionId: task.definitionId,
      runId: task.runId,
      stepId: task.stepId,
    },
    group: {
      key: `human-task:${task.definitionId}`,
      label: task.definitionId,
    },
  };
}
