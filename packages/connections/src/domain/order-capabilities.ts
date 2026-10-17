import type {
  ExternalId,
  OrderSnapshot,
  Page,
  PageQuery,
  WriteReceipt,
} from './capabilities.js';

interface ShippingMethodSnapshot {
  orderStatus: 'open' | 'shipped' | 'cancelled' | 'unknown';
  shippingMethod: ExternalId;
  isCancelled: boolean;
}

/** A recovery command is bound to an exact provider record and reviewed revision. */
interface OrderQuantityEditInput {
  /** Luma's operation UUID; the adapter fences and marks the provider write with it. */
  operationId: string;
  orderId: string;
  /** The order revision the approval reviewed. */
  expectedRevision: string;
  /** Returns removed units to stock; only applies to reductions. */
  restock: boolean;
  lines: { lineItemId: string; currentQuantity: number; quantity: number }[];
  /** Digest of the approved provider calculation; null when none was approved, which withholds. */
  calculationDigest: string | null;
}

/** Order reads and order quantity, shipping method and cancellation writes. */
export interface OrderCapabilities {
  /** Copies reviewed authoritative quantities to an existing unshipped shipping order.
   * The provider may lack atomic revisions and idempotency; the adapter must fence one dispatch.
   * This does not recalculate storefront prices, restock units, or create/delete source lines.
   */
  'orders.quantity.update': {
    input: {
      operationId: string;
      orderId: string;
      expectedRevision: string;
      lines: {
        lineItemId: string;
        currentQuantity: number;
        quantity: number;
      }[];
    };
    output: WriteReceipt;
  };
  /**
   * Sets approved quantities on existing, unfulfilled order lines through one provider order
   * edit. Adapters recalculate before sending, withhold any change from the approved
   * calculation, and send the commit at most once per operation.
   */
  'orders.quantity.edit': {
    input: OrderQuantityEditInput;
    output: WriteReceipt;
  };
  'orders.shipping-method.read': {
    input: PageQuery & { order: ExternalId };
    output: Page<ShippingMethodSnapshot>;
  };
  'orders.shipping-method.write': {
    input: {
      order: ExternalId;
      expectedShippingMethod: ExternalId;
      shippingMethod: ExternalId;
    };
    output: WriteReceipt;
  };
  /**
   * `order` reads exactly that order by its source ID; send it only to handlers whose
   * descriptor lists `order`. The page then holds that order when the source has it, or
   * nothing, and never a cursor.
   */
  'orders.read': {
    input: PageQuery & { order?: ExternalId };
    output: Page<OrderSnapshot>;
  };
  'orders.write': {
    input: { order: ExternalId; operation: 'cancel'; expectedRevision: string };
    output: WriteReceipt;
  };
}
