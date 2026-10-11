/** Types of the Needs you queue items, shared by presentation rules and the application port. */

type DecisionKind =
  | 'case'
  | 'replenishment'
  | 'fulfillment_recovery'
  | 'inventory_correction'
  | 'supplier_commitment'
  | 'workflow_handover'
  | 'message_reply';

export type DecisionReason =
  'approval' | 'run' | 'recovery' | 'manual_intervention' | 'uncertainty';

export type DecisionDomain =
  'orders' | 'fulfillment' | 'inventory' | 'procurement' | 'operations';

export type DecisionResponse =
  'decide' | 'run' | 'check' | 'investigate' | 'awaiting_other' | 'view_only';

export type DecisionView = 'all' | 'mine' | 'unassigned';

type DecisionRecordKind =
  'order' | 'fulfillment' | 'position' | 'sku' | 'product';

export type DecisionOwner =
  | { kind: 'case'; exceptionId: string }
  | { kind: 'workflow_run'; definitionId: string; runId: string }
  | {
      kind: 'app_fulfillment';
      appId: string;
      connectionId: string;
      orderId: string;
      fulfillmentId: string;
    }
  | { kind: 'app_inventory'; appId: string; positionId: string }
  | { kind: 'purchase_order'; purchaseOrderId: string }
  | { kind: 'message_thread'; threadId: string };

export interface DecisionAssignment {
  assigneeId: string | null;
  assignedBy: string;
  assignedAt: string;
  revision: number;
}

/** One decision waiting on a person, as the Needs you queue presents it. */
export interface DecisionItem {
  observeOnly?: boolean;
  id: string;
  kind: DecisionKind;
  reason: DecisionReason;
  domain: DecisionDomain;
  title: string;
  why: string;
  consequences: { response: string; text: string }[];
  change: { label: string; value: string }[];
  impact: { level: 'high' | 'medium' | 'low' | 'unknown'; text: string | null };
  urgency: 'expiring' | 'high' | 'normal';
  requestedAt: string;
  deadline: string | null;
  requesterId: string | null;
  evidence: {
    observedAt: string | null;
    validUntil: string | null;
    state: 'fresh' | 'stale' | 'unknown';
  };
  response: DecisionResponse;
  assignment: DecisionAssignment | null;
  subject: { label: string; detail: string | null };
  record: { kind: DecisionRecordKind; id: string } | null;
  owner: DecisionOwner;
  group: { key: string; label: string };
}

/**
 * A decision presented by its owner before ranking. `record` may name a source record that the
 * queue resolves to its canonical ID through tenant source mappings.
 */
export type DecisionCandidate = Omit<
  DecisionItem,
  'urgency' | 'evidence' | 'assignment' | 'record'
> & {
  evidence: { observedAt: string | null; validUntil: string | null };
  record:
    | { kind: DecisionRecordKind; id: string }
    | {
        kind: 'order' | 'fulfillment';
        source: { connectionId: string; externalId: string };
      }
    | null;
};
