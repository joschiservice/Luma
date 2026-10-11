import type { SourceRef } from './return-creations.js';

/** Provider-calculated refund or one warehouse stock addition. Approval freezes the whole plan. */
export type ReturnActionPlan =
  | {
      kind: 'refund';
      order: SourceRef;
      lines: { orderLine: SourceRef; quantity: number }[];
      amount: string;
      currency: string;
      transactions: { parentId: string; gateway: string; amount: string }[];
    }
  | {
      kind: 'restock';
      item: SourceRef;
      warehouse: SourceRef;
      quantity: number;
      baselineOnHand: string;
    };

/** An independent provider read. Acceptance and pending money do not establish success. */
export interface ReturnActionProof {
  outcome: 'passed' | 'failed' | 'inconclusive';
  payment: 'pending' | 'failed' | 'paid' | null;
  observedAt: string;
  evidenceRefs: string[];
}

/** One immutable settlement request; sent requests permanently hold their case/line slot. */
export interface ReturnAction {
  id: string;
  tenantId: string;
  caseId: string;
  connectionId: string;
  orderLineId: string | null;
  kind: 'refund' | 'restock';
  mappingIds: string[];
  plan: ReturnActionPlan;
  quote: { observedAt: string; evidenceRefs: string[] };
  caseDigest: string;
  requestDigest: string;
  actionId: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decisionId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  state:
    | 'approval_required'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'sending'
    | 'uncertain'
    | 'pending'
    | 'verified'
    | 'failed'
    | 'not_executed';
  sent: boolean;
  proof: ReturnActionProof | null;
  failure: string | null;
  updatedAt: string;
}
