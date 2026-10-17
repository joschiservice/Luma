import type { CitedRead, ExternalId } from './capabilities.js';

/** A provider quote for refunded units, or the baseline of a warehouse stock addition. */
export type ReturnSettlementPlan =
  | {
      kind: 'refund';
      order: ExternalId;
      lines: { orderLine: ExternalId; quantity: number }[];
      amount: string;
      currency: string;
      transactions: { parentId: string; gateway: string; amount: string }[];
    }
  | {
      kind: 'restock';
      item: ExternalId;
      warehouse: ExternalId;
      quantity: number;
      baselineOnHand: string;
    };

/** Reads the price or stock baseline without changing either system. */
export type ReturnSettlementQuote =
  | {
      kind: 'refund';
      order: ExternalId;
      lines: { orderLine: ExternalId; quantity: number }[];
    }
  | {
      kind: 'restock';
      item: ExternalId;
      warehouse: ExternalId;
      quantity: number;
    };

/** Frozen operation identity and plan. A write is never replayed by reconciliation. */
export interface ReturnSettlementWrite {
  operationId: string;
  plan: ReturnSettlementPlan;
}

/** Independently observed financial or stock outcome, with persisted source evidence. */
export interface ReturnSettlementProof {
  outcome: 'passed' | 'failed' | 'inconclusive';
  payment: 'pending' | 'failed' | 'partial' | 'paid' | null;
  observedAt: string;
  evidenceRefs: string[];
  /** The reads `evidenceRefs` names; a partial read cannot establish the outcome. */
  reads: CitedRead[];
}
