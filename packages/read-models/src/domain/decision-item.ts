/** Types of the Needs you queue items, shared by presentation rules and the application port. */

type DecisionKind =
  | 'case'
  | 'custom_field'
  | 'return_case'
  | 'replenishment'
  | 'fulfillment_recovery'
  | 'inventory_correction'
  | 'order_edit'
  | 'shipment_publication'
  | 'supplier_commitment'
  | 'workflow_handover'
  | 'human_task'
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
  | { kind: 'custom_field'; runId: string; stepId: string }
  | { kind: 'return_case'; caseId: string }
  | { kind: 'human_task'; definitionId: string; runId: string; stepId: string }
  | { kind: 'case'; exceptionId: string }
  | {
      kind: 'workflow_run';
      definitionId: string;
      runId: string;
      followUpProposalId?: string;
    }
  | {
      kind: 'app_fulfillment';
      appId: string;
      connectionId: string;
      orderId: string;
      fulfillmentId: string;
    }
  | { kind: 'app_inventory'; appId: string; positionId: string }
  | { kind: 'app_order'; appId: string; connectionId: string; orderId: string }
  | { kind: 'purchase_order'; purchaseOrderId: string }
  | { kind: 'purchasing_plan'; planId: string }
  | { kind: 'message_thread'; threadId: string };

/**
 * The record whose cited evidence backs a decision, as the evidence resolver names it, and the
 * references the decision relies on when they are only part of what that record cites.
 */
export interface DecisionEvidence {
  subject: {
    kind:
      | 'purchase_order'
      | 'purchasing_plan'
      | 'native_receipt'
      | 'app_decision'
      | 'return_creation'
      | 'return_settlement'
      | 'return_exchange_step'
      | 'reply'
      | 'case';
    id: string;
  };
  refs?: string[] | undefined;
}

export interface DecisionAssignment {
  assigneeId: string | null;
  assignedBy: string;
  assignedAt: string;
  revision: number;
}

/** One decision waiting on a person, as the Needs you queue presents it. */
export interface DecisionItem {
  outcome?: {
    state: 'approved' | 'rejected' | 'expired' | 'resolved';
    at: string | null;
    actorId: string | null;
    actorName: string | null;
    actorEmail: string | null;
    next: 'pending' | 'running' | 'verified' | 'failed' | 'uncertain';
    workflow: boolean;
    purchaseOrderId?: string | undefined;
    runId?: string | undefined;
    definitionId?: string | undefined;
  };

  previousChange?: { label: string; value: string }[] | undefined;
  automatic?: boolean | undefined;
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
  /** Where the decision's cited evidence resolves; absent when it cites none. */
  citedEvidence?: DecisionEvidence | undefined;
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
  /** Owner-bound immutable proposal; used only for a shared read-only action review. */
  actionReference?: { proposalId: string } | { runId: string; stepId: string };
  ownerAssignment?: DecisionAssignment | undefined;
  evidence: { observedAt: string | null; validUntil: string | null };
  record:
    | { kind: DecisionRecordKind; id: string }
    | {
        kind: 'order' | 'fulfillment';
        source: { connectionId: string; externalId: string };
      }
    | null;
};
