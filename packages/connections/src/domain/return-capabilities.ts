import type {
  CitedRead,
  CreatedReturnSnapshot,
  ExternalId,
  Page,
  PageQuery,
  Quantity,
  RefundSnapshot,
  ReturnOptionSnapshot,
  ReturnSnapshot,
  WriteReceipt,
} from './capabilities.js';
import type {
  ReturnExchangeProof,
  ReturnExchangeQuoted,
  ReturnExchangeRead,
} from './return-exchanges.js';
import type {
  ReturnSettlementPlan,
  ReturnSettlementProof,
  ReturnSettlementQuote,
  ReturnSettlementWrite,
} from './return-settlement.js';

/** Creates one return at the source for a Luma return case. */
interface ReturnCreation {
  /** The Luma return case ID; the adapter stores it so the return can be found again. */
  lumaCaseId: string;
  order: ExternalId;
  /** Approve this requested return instead of creating another return. */
  requestedReturn?: ExternalId;
  /** The source warehouse that receives the returned items. */
  warehouse: ExternalId;
  /** The source return reason recorded on every line. */
  reason: ExternalId;
  lines: { orderLine: ExternalId; quantity: Quantity }[];
}

/** Returns, refunds, restocks and exchanges. */
export interface ReturnCapabilities {
  /** Warehouses and return reasons to choose from when creating a return at the source. */
  'returns.options.read': {
    input: PageQuery;
    output: Page<ReturnOptionSnapshot>;
  };
  /** Finds the returns created at the source for a Luma return case. Resource `return`. */
  'returns.created.read': {
    input: PageQuery & {
      order: ExternalId;
      lumaCaseId: string;
      requestedReturn?: ExternalId;
    };
    output: Page<CreatedReturnSnapshot>;
  };
  /** Acceptance means the source recorded the return, not that any item came back. */
  'returns.create': { input: ReturnCreation; output: WriteReceipt };
  /** Calculates the exact refund or reads the selected warehouse stock baseline. */
  'returns.settlement.quote.read': {
    input: ReturnSettlementQuote;
    output: {
      plan: ReturnSettlementPlan;
      observedAt: string;
      evidenceRefs: string[];
      /** The reads `evidenceRefs` names. */
      reads: CitedRead[];
    };
  };
  /** Independently reconciles the operation's exact marker and approved outcome. */
  'returns.settlement.proof.read': {
    input: ReturnSettlementWrite;
    output: ReturnSettlementProof;
  };
  /** Financial write only: never restocks returned goods. */
  'returns.refund': { input: ReturnSettlementWrite; output: WriteReceipt };
  /** Adds only the approved resale units to the selected warehouse. */
  'returns.restock': { input: ReturnSettlementWrite; output: WriteReceipt };
  /** Quotes one exchange step from native store state; available inventory is not a reservation. */
  'returns.exchange.quote.read': {
    input: ReturnExchangeRead;
    output: ReturnExchangeQuoted;
  };
  /** Reads bounded, explicitly mapped storefront variant choices and current reported availability. */
  'returns.exchange.options.read': {
    input: { inventoryItems: ExternalId[] };
    output: {
      choices: {
        inventoryItem: ExternalId;
        variantId: string;
        name: string;
        available: number | null;
      }[];
      observedAt: string;
      evidenceRefs: string[];
      complete: boolean;
    };
  };
  /** Independently reconciles the operation's native return, replacement fulfillment and money. */
  /** Reads the native price of the processed replacement, including discounts and tax. */
  'returns.exchange.price.read': {
    input: ReturnExchangeRead;
    output: {
      total: { amount: string; currency: string } | null;
      observedAt: string;
      evidenceRefs: string[];
      /** The reads `evidenceRefs` names. */
      reads: CitedRead[];
    };
  };
  /** Finds exact ERP replacement orders and order-specific native reservations. */
  'returns.exchange.reservation.read': {
    input: { operationId: string; item: ExternalId };
    output: {
      complete: boolean;
      observedAt: string;
      evidenceRefs: string[];
      /** The reads `evidenceRefs` names. */
      reads: CitedRead[];
      orders: {
        id: ExternalId;
        total: { amount: string; currency: string } | null;
        paid: boolean;
        cancelled: boolean;
        exactLines: boolean;
        quantity: string;
        reserved: string | null;
      }[];
    };
  };
  'returns.exchange.proof.read': {
    input: ReturnExchangeRead;
    output: ReturnExchangeProof;
  };
  /** Records the replacement request through a native unprocessed Shopify return. */
  'returns.exchange.request': {
    input: ReturnExchangeRead;
    output: WriteReceipt;
  };
  /** Processes the exact native exchange and financial difference once. */
  'returns.exchange.process': {
    input: ReturnExchangeRead;
    output: WriteReceipt;
  };
  /** Cancels an unprocessed exchange intent before an operator changes the replacement or chooses a refund. */
  'returns.exchange.cancel': {
    input: ReturnExchangeRead;
    output: WriteReceipt;
  };
  /** Releases only the exchange's payment hold after fresh independent payment proof. */
  'returns.exchange.release': {
    input: ReturnExchangeRead;
    output: WriteReceipt;
  };
  /** Returns and refunds per order; the observation resource is `return` or `refund`. */
  'returns.read': {
    input: PageQuery & { order?: ExternalId };
    output: Page<ReturnSnapshot | RefundSnapshot>;
  };
}
