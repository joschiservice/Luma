import type {
  DecisionCandidate,
  DecisionDomain,
  DecisionItem,
  DecisionResponse,
} from './decision-item.js';

/** Proposals that lose their authority within this window rank first, whatever their impact. */
export const expiringWindowMinutes = 30;

/** Urgency by queue rank: 0 expires within the window, 1 high impact, 2 everything else. */
export const urgencies = ['expiring', 'high', 'normal'] as const;

/** Evidence is fresh until its owner's validity ends; without a validity it is unknown. */
export function evidenceState(
  validUntil: string | null,
  asOf: string,
): DecisionItem['evidence']['state'] {
  if (validUntil === null) return 'unknown';

  return Date.parse(validUntil) > Date.parse(asOf) ? 'fresh' : 'stale';
}

const classLabels: Record<string, string> = {
  inventory_mismatch: 'Stock mismatch',
  order_quantity_mismatch: 'Quantity difference',
  sync_failure: 'Connection issue',
  stuck_fulfillment: 'Fulfillment delay',
  workflow_failure: 'Workflow issue',
};

const subjectLabels: Record<string, string> = {
  order: 'Order',
  fulfillment: 'Fulfillment',
  sku: 'SKU',
  product: 'Product',
  inventory_position: 'Stock position',
  connection: 'Connection',
  supplier: 'Supplier',
  invoice: 'Invoice',
  workflow: 'Workflow',
  workflow_run: 'Workflow run',
};

const capabilityLabels: Record<string, string> = {
  'orders.shipping-method.write': 'shipping method correction',
  'procurement.purchase-order.create': 'purchase-order draft',
};

const humanize = (value: string) =>
  value
    .replaceAll(/[._-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

const scalar = (value: unknown) =>
  value === null || value === undefined ? 'None' : String(value);

/** Maps a case to the operational area whose records it affects. */
export function caseDomain(
  subjectKind: string | null,
  exceptionClass: string,
): DecisionDomain {
  if (
    ['sku', 'inventory_position', 'position', 'product'].includes(
      subjectKind ?? '',
    ) ||
    exceptionClass === 'inventory_mismatch'
  )
    return 'inventory';
  if (subjectKind === 'fulfillment' || exceptionClass === 'stuck_fulfillment')
    return 'fulfillment';
  if (subjectKind === 'order') return 'orders';
  if (['supplier', 'purchase_order', 'invoice'].includes(subjectKind ?? ''))
    return 'procurement';

  return 'operations';
}

/** The compact case facts selected by the exceptions owner's decision query. */
export interface CaseDecisionFacts {
  observe_only?: boolean;
  require_independent_approval?: boolean;
  exception_id: string;
  reason: 'approval' | 'manual_intervention' | 'uncertainty';
  requested_at: string;
  severity: string | null;
  class: string;
  state: string;
  subject: {
    subjectKind?: string;
    subjectId?: string;
    scope?: string[];
  } | null;
  diagnosis_status: string | null;
  summary: string | null;
  valid_until: string | null;
  observed_at: string | null;
  manual_step: string | null;
  exposed_quantity: string | null;
  exposed_unit: string | null;
  requester_id: string | null;
  decision_id: string | null;
  proposal: {
    id?: string;
    capability: string;
    target: { kind: string; id: string };
    parameters: Record<string, string | number | boolean | null>;
    expectedPostcondition: Record<string, string | number | boolean | null>;
    risk: 'low' | 'medium' | 'high';
    expiresAt: string;
    preconditions: { validUntil: string };
  } | null;
}

const minimum = (values: (string | null | undefined)[]) => {
  const present = values.filter((v): v is string => !!v);

  return present.length
    ? present.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
    : null;
};

/** Returns when an approval proposal stops being approvable; null for other reasons. */
export function caseDeadline(facts: CaseDecisionFacts): string | null {
  return facts.reason === 'approval' && facts.proposal
    ? minimum([
        facts.proposal.expiresAt,
        facts.proposal.preconditions.validUntil,
        facts.valid_until,
      ])
    : null;
}

/** The workspace permissions that change what a reader may do with a presented decision. */
type DecisionPermission = 'decisions.respond';

/** The person reading the queue and a check of their current permissions. */
export interface DecisionReader {
  id: string;
  can(permission: DecisionPermission): boolean;
}

/**
 * Presents a case that needs a person. Stale diagnoses keep only their identity; their summary
 * and manual step are withheld as the case inbox does. Approvals are decided by readers who can
 * respond to decisions under the workspace approval rules; the other reasons ask the reader to investigate
 * in the issue, which every reader of the case may open.
 */
export function presentCase(
  facts: CaseDecisionFacts,
  reader: DecisionReader,
  asOf: string,
): DecisionCandidate {
  const label = classLabels[facts.class] ?? 'Operational issue';
  const kind = facts.subject?.subjectKind ?? null;
  const subject = kind
    ? `${subjectLabels[kind] ?? humanize(kind)} ${facts.subject?.subjectId ?? ''}`.trim()
    : label;
  const current =
    facts.diagnosis_status !== 'pending' &&
    (facts.valid_until === null ||
      Date.parse(facts.valid_until) > Date.parse(asOf));
  const summary = current ? facts.summary : null;
  const proposal =
    facts.reason === 'approval' || facts.observe_only ? facts.proposal : null;
  const action = proposal
    ? (capabilityLabels[proposal.capability] ?? humanize(proposal.capability))
    : null;
  const exposed =
    facts.exposed_quantity !== null
      ? `${facts.exposed_quantity}${facts.exposed_unit ? ` ${facts.exposed_unit}` : ''} exposed`
      : null;
  const impactLevel =
    facts.severity === 'high' ||
    facts.severity === 'medium' ||
    facts.severity === 'low'
      ? facts.severity
      : 'unknown';
  const response: DecisionResponse = facts.observe_only
    ? 'view_only'
    : facts.reason !== 'approval' || !proposal
      ? 'investigate'
      : facts.requester_id === reader.id &&
          facts.require_independent_approval !== false
        ? 'awaiting_other'
        : reader.can('decisions.respond')
          ? 'decide'
          : 'view_only';
  const escalate = {
    response: 'Escalate',
    text: 'No action runs. The issue stays open and is marked for investigation.',
  };

  const base = {
    observeOnly: facts.observe_only ?? false,
    id: `case:${facts.exception_id}`,
    kind: 'case' as const,
    reason: facts.reason,
    domain: caseDomain(kind, facts.class),
    requestedAt: facts.requested_at,
    deadline: caseDeadline(facts),
    requesterId: proposal ? facts.requester_id : null,
    evidence: { observedAt: facts.observed_at, validUntil: facts.valid_until },
    response,
    subject: { label: subject, detail: summary },
    record: null,
    owner: { kind: 'case' as const, exceptionId: facts.exception_id },
    impact: { level: impactLevel, text: exposed },
  } satisfies Partial<DecisionCandidate>;

  if (facts.reason === 'approval' || facts.observe_only)
    return {
      ...base,
      title: facts.observe_only
        ? `Observe-only: ${action ?? label}`
        : action
          ? `Approve ${action}`
          : `${label} needs approval`,
      why: facts.observe_only
        ? 'Would run when writes are enabled. No provider change was made.'
        : proposal
          ? 'Workspace policy requires someone else who can approve changes to approve this exact proposal before Luma acts.'
          : 'The proposal expired before anyone approved it. Open the issue to review what changed or escalate it.',
      consequences: facts.observe_only
        ? [escalate]
        : proposal
          ? [
              {
                response: 'Approve',
                text: 'Luma checks eligibility again, applies this one change and keeps the issue open until a fresh read verifies the result.',
              },
              {
                response: 'Reject',
                text: 'Nothing changes. The issue stays open for a different approach.',
              },
              escalate,
            ]
          : [escalate],
      change: proposal
        ? [
            { label: 'Action', value: humanize(action ?? proposal.capability) },
            {
              label: 'Target',
              value: `${subjectLabels[proposal.target.kind] ?? humanize(proposal.target.kind)} ${proposal.target.id}`,
            },
            ...Object.entries(proposal.parameters)
              .slice(0, 6)
              .map(([key, value]) => ({
                label: humanize(key),
                value: scalar(value),
              })),
            ...Object.entries(proposal.expectedPostcondition)
              .slice(0, 3)
              .map(([key, value]) => ({
                label: `Expected ${humanize(key).toLowerCase()}`,
                value: scalar(value),
              })),
            { label: 'Risk', value: humanize(proposal.risk) },
          ]
        : [{ label: 'Issue', value: label }],
      ...(proposal?.id ? { actionReference: { proposalId: proposal.id } } : {}),
      group: {
        key: `case:${facts.class}:approval`,
        label: `${label} fixes awaiting approval`,
      },
    };

  const affected = [
    { label: 'Issue', value: label },
    { label: 'Affected', value: subject },
    ...(exposed ? [{ label: 'Exposed', value: exposed }] : []),
    ...(facts.severity
      ? [{ label: 'Severity', value: humanize(facts.severity) }]
      : []),
  ];

  if (facts.reason === 'manual_intervention')
    return {
      ...base,
      title: `${label} needs a manual step`,
      why:
        (current ? facts.manual_step : null) ??
        'Luma can’t make this change itself. A person has to take the next step.',
      consequences: [
        {
          response: 'Resolve',
          text: 'Take the step in the source system. Luma closes the issue only after a fresh read no longer shows the problem.',
        },
        escalate,
      ],
      change: affected,
      group: {
        key: `case:${facts.class}:manual_intervention`,
        label: `${label}: manual steps`,
      },
    };

  return {
    ...base,
    title:
      facts.state === 'escalated'
        ? `${label} was escalated`
        : `${label} needs review`,
    why:
      facts.state === 'escalated'
        ? 'An operator escalated this issue. Luma won’t act on it until a person reviews it.'
        : 'The evidence is incomplete or conflicting, so Luma stopped instead of acting.',
    consequences: [
      {
        response: 'Investigate',
        text: 'Review the evidence and findings in the issue. Luma won’t act until the uncertainty is resolved.',
      },
    ],
    change: affected,
    group: {
      key: `case:${facts.class}:uncertainty`,
      label: `${label}: needs review`,
    },
  };
}

/** The procurement owner's pending purchase-order proposal, as the queue reads it. */
export interface ReplenishmentProposal {
  context?: { productTitle: string | null } | null;
  runId: string;
  definitionId: string;
  positionId: string;
  sku: string;
  supplier: string;
  quantity: number;
  unit: string | null;
  available: number | null;
  minimum: number;
  target: number;
  approvalQuantity: number;
  reference: string | null;
  checkedAt: string | null;
  requestedAt: string;
  requesterId: string;
  expiresAt: string;
  risk: 'low' | 'medium' | 'high';
  canRespond: boolean;
}

const plural = (value: number, unit: string | null) =>
  unit ? `${value} ${unit}` : String(value);

/** Presents a replenishment proposal waiting for approval, with its stock evidence. */
export function presentReplenishment(
  item: ReplenishmentProposal,
  readerId: string,
): DecisionCandidate {
  const high = item.risk === 'high';
  const unit = item.unit;

  return {
    id: `replenishment:${item.runId}`,
    kind: 'replenishment',
    reason: 'approval',
    domain: 'procurement',
    title: `Approve purchase-order draft for ${item.quantity} × ${item.context?.productTitle ? `${item.context.productTitle} (${item.sku})` : item.sku}`,
    why: `Each replenishment proposal needs someone who can manage procurement, other than the rule’s principal, to approve it before Luma creates the draft.${
      high
        ? ` The quantity is above the rule’s ${item.approvalQuantity}-unit approval threshold. This does not measure financial impact.`
        : ''
    }`,
    consequences: [
      {
        response: 'Approve',
        text: 'Luma checks stock, open orders and the supplier again, then creates a purchase-order draft and verifies it with a fresh read. Nothing is sent to the supplier.',
      },
      {
        response: 'Reject',
        text: 'No order is created and the run ends. Stock stays below its minimum until the next check.',
      },
    ],
    change: [
      { label: 'Product', value: item.context?.productTitle ?? 'Not reported' },
      { label: 'SKU', value: item.sku },
      { label: 'Supplier', value: item.supplier },
      { label: 'Quantity', value: plural(item.quantity, unit) },
      {
        label: 'Available',
        value:
          item.available === null ? 'Unknown' : plural(item.available, unit),
      },
      { label: 'Minimum', value: plural(item.minimum, unit) },
      { label: 'Target', value: plural(item.target, unit) },
      ...(item.reference
        ? [{ label: 'Reference', value: item.reference }]
        : []),
      { label: 'Result', value: 'Purchase-order draft, not sent' },
    ],
    impact: {
      level: 'unknown',
      text:
        item.available === null
          ? 'Available stock unknown'
          : `${plural(item.available, unit)} available, below the minimum of ${item.minimum}`,
    },
    requestedAt: item.requestedAt,
    deadline: item.expiresAt,
    requesterId: item.requesterId,
    evidence: { observedAt: item.checkedAt, validUntil: item.expiresAt },
    response: item.canRespond
      ? 'decide'
      : item.requesterId === readerId
        ? 'awaiting_other'
        : 'view_only',
    subject: {
      label: `Stock of ${item.sku}`,
      detail: `Supplier ${item.supplier}`,
    },
    record: { kind: 'position', id: item.positionId },
    owner: {
      kind: 'workflow_run',
      definitionId: item.definitionId,
      runId: item.runId,
    },
    group: {
      key: 'replenishment:approval',
      label: 'Purchase-order drafts awaiting approval',
    },
  };
}

/** Something about a sent or sending purchase order that needs a person, from the procurement owner. */
export interface SupplierCommitmentDecision {
  submissionId?: string | undefined;
  observeOnly?: boolean;
  key: string;
  kind:
    | 'submission_approval'
    | 'submission_uncertain'
    | 'submission_failed'
    | 'review_commitment'
    | 'commitment_changed'
    | 'confirmation_overdue'
    | 'delivery_overdue'
    | 'receipt_difference';
  purchaseOrderId: string;
  reference: string;
  supplierName: string;
  summary: string;
  /** When it became due or was raised. */
  dueAt: string;
  /** Approval requests expire; other items have no deadline. */
  expiresAt: string | null;
  requesterId: string | null;
  canRespond: boolean;
  requestedDeliveryDate: string | null;
  lines: { sku: string; quantity: number; unit: string }[];
  line: { sku: string; quantity: number; unit: string } | null;
  commitment: {
    kind: string;
    quantity: number | null;
    date: string | null;
    text: string | null;
    reasons: string[];
  } | null;
}

const reasonText: Record<string, string> = {
  low_confidence: 'the wording is ambiguous',
  quantity_changed: 'the quantity differs from the order',
  date_later: 'the date is later than requested',
  unmatched_line: 'it could not be matched to an order line',
  supplier_condition: 'the supplier added a condition',
};

const said = (
  c: NonNullable<SupplierCommitmentDecision['commitment']>,
  unit: string | null,
) =>
  c.kind === 'confirmed_quantity'
    ? `Confirms ${c.quantity ?? '?'}${unit ? ` ${unit}` : ''}`
    : c.kind === 'promised_date'
      ? `Promises delivery on ${c.date ?? 'an unclear date'}`
      : c.kind === 'shipped'
        ? `Says goods were shipped${c.date ? ` on ${c.date}` : ''}`
        : (c.text ?? 'States a condition');

/** Presents a supplier-lifecycle item with what each response causes. */
export function presentSupplierCommitment(
  item: SupplierCommitmentDecision,
  readerId: string,
): DecisionCandidate {
  const order = { label: 'Purchase order', value: item.reference };
  const supplier = { label: 'Supplier', value: item.supplierName };
  const lines = item.lines
    .map((l) => `${l.quantity} ${l.unit} ${l.sku}`)
    .join(', ');
  const base = {
    ...(item.submissionId
      ? { actionReference: { runId: item.submissionId, stepId: 'submit' } }
      : {}),
    id: `supplier:${item.key}`,
    kind: 'supplier_commitment' as const,
    domain: 'procurement' as const,
    requestedAt: item.dueAt,
    requesterId: item.requesterId,
    subject: { label: item.reference, detail: `Supplier ${item.supplierName}` },
    record: null,
    owner: {
      kind: 'purchase_order' as const,
      purchaseOrderId: item.purchaseOrderId,
    },
  };
  const respond = item.canRespond
    ? ('decide' as const)
    : ('view_only' as const);
  switch (item.kind) {
    case 'submission_approval':
      return {
        ...base,
        reason: 'approval',
        observeOnly: item.observeOnly ?? false,
        title: item.observeOnly
          ? 'Observe-only'
          : `Approve sending ${item.reference} to ${item.supplierName}`,
        why: item.observeOnly
          ? 'Would run when writes are enabled. Luma keeps this proposal and its evidence, but makes no provider changes.'
          : 'Placing an order with a supplier is an external commitment. Someone who can manage procurement approves the exact order under the workspace rules first.',
        consequences: item.observeOnly
          ? []
          : [
              {
                response: 'Approve',
                text: 'Luma checks the order and supplier link again, places it once in the purchasing system and verifies it with a separate read. The purchasing system sends it to the supplier.',
              },
              {
                response: 'Reject',
                text: 'Nothing is sent. The order stays in Luma.',
              },
            ],
        change: [
          order,
          supplier,
          { label: 'Lines', value: lines },
          ...(item.requestedDeliveryDate
            ? [
                {
                  label: 'Requested delivery',
                  value: item.requestedDeliveryDate,
                },
              ]
            : []),
          { label: 'Result', value: 'Order placed with the supplier' },
        ],
        impact: {
          level: 'high',
          text: 'Commits the business to a supplier order',
        },
        deadline: item.expiresAt,
        evidence: { observedAt: item.dueAt, validUntil: item.expiresAt },
        response: item.observeOnly
          ? 'view_only'
          : item.canRespond
            ? 'decide'
            : item.requesterId === readerId
              ? 'awaiting_other'
              : 'view_only',
        group: {
          key: 'supplier:submission_approval',
          label: 'Orders waiting to be sent',
        },
      };
    case 'submission_uncertain':
      return {
        ...base,
        reason: 'recovery',
        title: `Check whether ${item.reference} reached the purchasing system`,
        why: 'The purchasing system did not confirm the request. Luma will not send it again until a read settles whether the order exists.',
        consequences: [
          {
            response: 'Check',
            text: 'Luma reads the purchasing system. If the order is there it counts as sent; otherwise it stays unresolved.',
          },
        ],
        change: [order, supplier, { label: 'Lines', value: lines }],
        impact: { level: 'high', text: 'Sending state unknown' },
        deadline: null,
        evidence: { observedAt: item.dueAt, validUntil: null },
        response: item.canRespond ? 'check' : 'view_only',
        group: {
          key: 'supplier:submission_uncertain',
          label: 'Orders with an uncertain send',
        },
      };
    case 'review_commitment':
      return {
        ...base,
        reason: 'uncertainty',
        title: `Review what ${item.supplierName} said about ${item.reference}`,
        why: `Luma read this from a supplier message but won’t count it until a person checks it, because ${
          item.commitment?.reasons
            .map((r) => reasonText[r] ?? r)
            .join(' and ') || 'it needs review'
        }.`,
        consequences: [
          {
            response: 'Confirm',
            text: 'It counts as the supplier’s commitment for this order.',
          },
          {
            response: 'Reject',
            text: 'It stays in the history but does not count.',
          },
        ],
        change: [
          order,
          ...(item.line ? [{ label: 'Line', value: item.line.sku }] : []),
          ...(item.commitment
            ? [
                {
                  label: 'Supplier says',
                  value: said(item.commitment, item.line?.unit ?? null),
                },
              ]
            : []),
        ],
        impact: { level: 'medium', text: null },
        deadline: null,
        evidence: { observedAt: item.dueAt, validUntil: null },
        response: respond,
        group: { key: 'supplier:review', label: 'Supplier messages to review' },
      };
    case 'submission_failed':
      return {
        ...base,
        reason: 'manual_intervention',
        title: item.summary,
        why: 'The supplier did not receive a verified submission. Review the failure before requesting a new send.',
        consequences: [],
        change: [order, supplier],
        impact: { level: 'medium', text: null },
        deadline: null,
        evidence: { observedAt: item.dueAt, validUntil: null },
        response: respond,
        group: {
          key: 'supplier:failed',
          label: 'Supplier submissions needing attention',
        },
      };
    case 'receipt_difference':
    case 'commitment_changed':
      return {
        ...base,
        reason: 'approval',
        title: item.summary,
        why: 'The supplier’s commitment differs from the order. Accept it so it becomes the expected delivery, or follow up with the supplier.',
        consequences: [
          {
            response: 'Accept',
            text: 'The changed quantity or date becomes what Luma expects.',
          },
          {
            response: 'Follow up',
            text: 'Record what you asked the supplier and when Luma should check again.',
          },
        ],
        change: [
          order,
          supplier,
          ...(item.line
            ? [
                {
                  label: 'Ordered',
                  value: `${item.line.quantity} ${item.line.unit} ${item.line.sku}`,
                },
              ]
            : []),
          ...(item.commitment
            ? [
                {
                  label: 'Supplier says',
                  value: said(item.commitment, item.line?.unit ?? null),
                },
              ]
            : []),
        ],
        impact: { level: 'medium', text: null },
        deadline: null,
        evidence: { observedAt: item.dueAt, validUntil: null },
        response: respond,
        group: { key: 'supplier:changed', label: 'Supplier changes to accept' },
      };
    case 'confirmation_overdue':
    case 'delivery_overdue':
      return {
        ...base,
        reason: 'manual_intervention',
        title: item.summary,
        why:
          item.kind === 'confirmation_overdue'
            ? 'The supplier has not confirmed the order within the agreed time. Luma cannot chase the supplier itself.'
            : 'Units the supplier committed to are not booked as received by their expected date.',
        consequences: [
          {
            response: 'Follow up',
            text: 'Record what you did and when Luma should check again. It returns here if nothing changes by then.',
          },
        ],
        change: [
          order,
          supplier,
          ...(item.line ? [{ label: 'Line', value: `${item.line.sku}` }] : []),
          { label: 'Due', value: item.dueAt.slice(0, 10) },
        ],
        impact: { level: 'high', text: 'Stock may run short' },
        deadline: item.dueAt,
        evidence: { observedAt: null, validUntil: null },
        response: item.canRespond ? 'investigate' : 'view_only',
        group: {
          key: `supplier:${item.kind}`,
          label:
            item.kind === 'confirmation_overdue'
              ? 'Supplier confirmations overdue'
              : 'Deliveries overdue',
        },
      };
  }
}

/** A workflow run that handed an owner's follow-up to a person, while it is still open. */
export interface WorkflowHandoverDecision {
  definitionId: string;
  name: string;
  runId: string;
  handedOverAt: string;
  title: string;
  detail: string;
  domain: DecisionDomain;
  record: DecisionCandidate['record'];
}

/** Presents a handed-over follow-up. It leaves the queue once its owner no longer reports it. */
export function presentWorkflowHandover(
  item: WorkflowHandoverDecision,
): DecisionCandidate {
  return {
    id: `workflow-handover:${item.runId}`,
    kind: 'workflow_handover',
    reason: 'manual_intervention',
    domain: item.domain,
    title: item.title,
    why: `${item.name} checked it again and it still needs a person. Luma can’t resolve it by itself.`,
    consequences: [
      {
        response: 'Follow up',
        text: 'Act on the record. This leaves Needs you once Luma no longer sees the follow-up.',
      },
    ],
    change: [{ label: 'Context', value: item.detail }],
    impact: { level: 'medium', text: null },
    requestedAt: item.handedOverAt,
    deadline: null,
    requesterId: null,
    evidence: { observedAt: item.handedOverAt, validUntil: null },
    response: 'investigate',
    subject: { label: item.title, detail: item.detail },
    record: item.record,
    owner: {
      kind: 'workflow_run',
      definitionId: item.definitionId,
      runId: item.runId,
    },
    group: {
      key: `workflow-handover:${item.definitionId}`,
      label: item.name,
    },
  };
}

/** An open message thread whose reply is due within 30 minutes or overdue. */
export interface MessageReplyDecision {
  threadId: string;
  subject: string;
  /** The correspondent as written, such as `Anna <anna@supplier.example>`. */
  correspondent: string | null;
  mailboxLabel: string;
  replyDueAt: string;
  /** When the unanswered message arrived. */
  receivedAt: string;
  canRespond: boolean;
}

/** Presents a reply that is due. It leaves the queue once someone replies, closes the thread or moves the deadline. */
export function presentMessageReply(
  item: MessageReplyDecision,
): DecisionCandidate {
  return {
    id: `message:${item.threadId}`,
    kind: 'message_reply',
    reason: 'manual_intervention',
    domain: 'operations',
    title: item.subject || '(no subject)',
    why: 'A message is waiting for a reply and its reply deadline is reached. Luma does not answer on its own.',
    consequences: [
      {
        response: 'Reply',
        text: 'Answer from the thread. Replies that commit to dates, quantities or money need approval first.',
      },
      {
        response: 'Change the deadline',
        text: 'Set a later deadline or close the thread when no reply is needed.',
      },
    ],
    change: [
      ...(item.correspondent
        ? [{ label: 'From', value: item.correspondent }]
        : []),
      { label: 'Mailbox', value: item.mailboxLabel },
      { label: 'Reply due', value: item.replyDueAt },
    ],
    impact: { level: 'unknown', text: null },
    requestedAt: item.receivedAt,
    deadline: item.replyDueAt,
    requesterId: null,
    evidence: { observedAt: item.receivedAt, validUntil: null },
    response: item.canRespond ? 'investigate' : 'view_only',
    subject: {
      label: item.subject || '(no subject)',
      detail: item.correspondent,
    },
    record: null,
    owner: { kind: 'message_thread', threadId: item.threadId },
    group: { key: 'message:reply', label: 'Replies due' },
  };
}
