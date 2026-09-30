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

/**
 * Presents a case that needs a person. Stale diagnoses keep only their identity; their summary
 * and manual step are withheld as the case inbox does.
 */
export function presentCase(
  facts: CaseDecisionFacts,
  reader: { id: string; role: 'owner' | 'admin' | 'member' },
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
  const proposal = facts.reason === 'approval' ? facts.proposal : null;
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
  const staff = reader.role !== 'member';
  const response: DecisionResponse =
    facts.reason !== 'approval' || !proposal
      ? 'investigate'
      : !staff
        ? 'view_only'
        : facts.requester_id === reader.id
          ? 'awaiting_other'
          : 'decide';
  const escalate = {
    response: 'Escalate',
    text: 'No action runs. The issue stays open and is marked for investigation.',
  };

  const base = {
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

  if (facts.reason === 'approval')
    return {
      ...base,
      title: action ? `Approve ${action}` : `${label} needs approval`,
      why: proposal
        ? 'Workspace policy requires an owner or admin other than the requester to approve this exact proposal before Luma acts.'
        : 'The proposal expired before anyone approved it. Open the issue to review what changed or escalate it.',
      consequences: proposal
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
    title: `Approve purchase-order draft for ${item.quantity} × ${item.sku}`,
    why: `Each replenishment proposal needs an owner or admin other than the rule’s principal to approve it before Luma creates the draft.${
      high
        ? ` The quantity is above the rule’s ${item.approvalQuantity}-unit limit, so it is high risk.`
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
      level: high ? 'high' : 'medium',
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
