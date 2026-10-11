import type { ExchangeConsistencyReport } from './return-consistency.js';
import type { SourceRef } from './return-creations.js';

/** One explicitly mapped replacement in the store and Wawi's reported availability pool. */
export interface ExchangeReplacement {
  skuId: string;
  mappingIds: string[];
  inventoryItem: SourceRef;
  variantId: string;
  wawiConnectionId: string;
  item: SourceRef;
  quantity: number;
}

/** The inspected units credited in this exchange; missing units never enter its financial plan. */
interface ExchangeReturnLine {
  orderLineId: string;
  source: SourceRef;
  quantity: number;
  reason: string;
}

/** A native Shopify financial outcome, independent of physical stock and fulfillment progress. */
interface ExchangeFinancialPlan {
  kind: 'even' | 'charge' | 'refund';
  amount: string;
  currency: string;
  transactions: { parentId: string; amount: string }[];
  priorSuccessfulTransactionIds: string[];
}

/** Frozen intent for exactly one independently approved provider write. */
export type ExchangeStepPlan =
  | {
      kind: 'request';
      marker: string;
      order: SourceRef;
      lines: ExchangeReturnLine[];
      replacement: ExchangeReplacement;
    }
  | {
      kind: 'process';
      marker: string;
      order: SourceRef;
      returnId: string;
      returnLines: { id: string; quantity: number }[];
      exchangeLine: { id: string; quantity: number };
      replacement: ExchangeReplacement;
      financial: ExchangeFinancialPlan;
    }
  | {
      kind: 'cancel';
      marker: string;
      order: SourceRef;
      returnId: string;
      lines: ExchangeReturnLine[];
      replacement: ExchangeReplacement;
    }
  | {
      kind: 'release';
      marker: string;
      returnLines: { id: string; quantity: number }[];
      exchangeLine: { id: string; quantity: number };
      replacement: ExchangeReplacement;
      order: SourceRef;
      returnId: string;
      fulfillmentOrderId: string;
      holdId: string;
      financial: ExchangeFinancialPlan;
    };

/** Fresh source proof. A prepared fulfillment can coexist with pending or failed money. */
export interface ExchangeProof {
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
  financial: ExchangeFinancialPlan | null;
}

/** A persisted approval and execution identity; sent writes are reconciled without redispatch. */
export interface ExchangeStep {
  /** Version 2 binds a plan digest within admission's bounded scalar parameters. */
  intentVersion?: 2;
  id: string;
  actionId: string;
  operationId: string;
  tenantId: string;
  caseId: string;
  connectionId: string;
  plan: ExchangeStepPlan;
  caseDigest: string;
  requestDigest: string;
  quote: { observedAt: string; evidenceRefs: string[] };
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
    | 'verified'
    | 'failed'
    | 'not_executed';
  sent: boolean;
  proof: ExchangeProof | null;
  failure: string | null;
  updatedAt: string;
}

/** One case operation across source requests, replacement choices, payment waits and retries. */
export interface ReturnExchange {
  id: string;
  tenantId: string;
  caseId: string;
  connectionId: string;
  startedBy: string;
  startedAt: string;
  ownerId: string;
  revision: number;
  choice: {
    kind: 'wait' | 'different_item' | 'refund';
    by: string;
    at: string;
  } | null;
  currentAttemptId: string;
  replacementName: string;
  request: Extract<ExchangeStepPlan, { kind: 'request' }>;
  availability: {
    available: boolean | null;
    observedAt: string;
    evidenceRefs: string[];
  } | null;
  /** Once processing could have been sent, a second replacement intent is forbidden. */
  processingStarted: boolean;
  completion?: ExchangeConsistencyReport;
  updatedAt: string;
}
