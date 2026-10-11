import type { ExternalId } from './capabilities.js';

/** One explicitly mapped replacement in the store and Wawi's reported availability pool. */
interface ReturnExchangeReplacement {
  skuId: string;
  mappingIds: string[];
  inventoryItem: ExternalId;
  variantId: string;
  wawiConnectionId: string;
  item: ExternalId;
  quantity: number;
}

/** The inspected units credited in this exchange; missing units never enter its financial plan. */
interface ReturnExchangeLine {
  orderLineId: string;
  source: ExternalId;
  quantity: number;
  reason: string;
}

/** A native Shopify financial outcome, independent of physical stock and fulfillment progress. */
interface ReturnExchangeFinancial {
  kind: 'even' | 'charge' | 'refund';
  amount: string;
  currency: string;
  transactions: { parentId: string; amount: string }[];
  priorSuccessfulTransactionIds: string[];
}

/** Frozen intent for exactly one independently approved provider write. */
export type ReturnExchangePlan =
  | {
      kind: 'request';
      marker: string;
      order: ExternalId;
      lines: ReturnExchangeLine[];
      replacement: ReturnExchangeReplacement;
    }
  | {
      kind: 'process';
      marker: string;
      order: ExternalId;
      returnId: string;
      returnLines: { id: string; quantity: number }[];
      exchangeLine: { id: string; quantity: number };
      replacement: ReturnExchangeReplacement;
      financial: ReturnExchangeFinancial;
    }
  | {
      kind: 'cancel';
      marker: string;
      order: ExternalId;
      returnId: string;
      lines: ReturnExchangeLine[];
      replacement: ReturnExchangeReplacement;
    }
  | {
      kind: 'release';
      marker: string;
      returnLines: { id: string; quantity: number }[];
      exchangeLine: { id: string; quantity: number };
      replacement: ReturnExchangeReplacement;
      order: ExternalId;
      returnId: string;
      fulfillmentOrderId: string;
      holdId: string;
      financial: ReturnExchangeFinancial;
    };

/** Fresh source proof. A prepared fulfillment can coexist with pending or failed money. */
export interface ReturnExchangeProof {
  outcome: 'passed' | 'failed' | 'inconclusive';
  observedAt: string;
  evidenceRefs: string[];
  returnId: string | null;
  processLines: {
    returnLines: { id: string; quantity: number }[];
    exchangeLine: { id: string; quantity: number };
  } | null;
  fulfillmentOrderId: string | null;
  paymentHoldId: string | null;
  fulfillmentReady: boolean;
  payment:
    'not_required' | 'pending' | 'failed' | 'partial' | 'paid' | 'unknown';
  financial: ReturnExchangeFinancial | null;
}

/** The root business operation and frozen plan for a quoted write or independent reconciliation. */
export interface ReturnExchangeRead {
  operationId: string;
  plan: ReturnExchangePlan;
}

/** An exact source quote; availability is a current report, never a reservation. */
export interface ReturnExchangeQuoted {
  plan: ReturnExchangePlan;
  available: boolean;
  observedAt: string;
  evidenceRefs: string[];
}
