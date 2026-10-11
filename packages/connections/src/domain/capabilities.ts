import type { ConnectorFailure } from '@luma/connector-core';

export { ConnectorError } from '@luma/connector-core';

export type {
  ConnectorErrorCode,
  ConnectorFailure,
} from '@luma/connector-core';

/** Provider IDs are opaque and case-preserved; scopeKey identifies a parent-local namespace. */
export interface ExternalId {
  externalId: string;
  scopeKey: string;
}

export interface SourceIdentity extends ExternalId {
  tenantId: string;
  connectionId: string;
  provider: string;
  resource:
    | 'order'
    | 'order_line'
    | 'sku'
    | 'location'
    | 'fulfillment'
    | 'product'
    | 'customer'
    | 'return'
    | 'refund'
    | 'supplier'
    | 'purchase_order'
    | 'message';
}

export interface Observation<T> {
  id: string;
  source: SourceIdentity;
  kind: 'snapshot' | 'tombstone';
  /** When the point-in-time read started, on Luma's clock; not when the result was received. */
  observedAt: string;
  /** Source-reported modification time; null when the source does not expose one. */
  sourceUpdatedAt: string | null;
  sourceRevision: string | null;
  /** Identifies the adapter normalization that produced `data`; bump it when output changes. */
  adapterVersion: string;
  schemaVersion: 1;
  data: T;
}

export interface PageQuery {
  cursor?: string;
  limit: number;
  /**
   * Returns only records the source changed at or after this time, on the source's clock.
   * Send it only to handlers whose descriptor lists `updatedSince`; others reject it.
   */
  updatedSince?: string;
  /** Creation window; send only when the handler advertises this filter. */
  createdSince?: string;
  /** Stable scan identity for a resumable provider history export. */
  historyImport?: { key: string; chunkSize?: number };
}

/**
 * The source limits reads to records created at or after `availableFrom`. `requirement`
 * names the provider permission that removes the limit, when one exists.
 */
export interface HistoryLimit {
  availableFrom: string;
  requirement: string | null;
}

/** Only a complete successful scan can establish that an item is absent. */
export interface Page<T> {
  items: Observation<T>[];
  nextCursor: string | null;
  completeness: 'complete' | 'partial';
  /**
   * Source-reported number of records the whole query matches, when the source reports it.
   * It is an estimate for progress, not a completeness check.
   */
  total?: number | null;
  /** Present when the source hides older records from this connection. */
  history?: HistoryLimit | null;
  /** Export is preparing: checkpoint the cursor, but do not complete coverage. */
  deferred?: boolean;
  /** Provider advice before the next page, including successful budget depletion. */
  retryAfterMs?: number;
}

export interface Quantity {
  /** Decimal string with at most six fractional and fourteen integer digits. */
  amount: string;
  unit: string;
}

/** A decimal amount in an ISO 4217 currency, as reported by the source. */
export interface Money {
  /** Decimal string with at most six fractional and fourteen integer digits. */
  amount: string;
  currency: string;
}

export interface OrderSnapshot {
  /** Marketplace order number reported by an ERP; a suggestion signal, never identity. */
  externalOrderNumber?: string | null;
  displayNumber: string | null;
  /** Source-provided fulfillment deadline; omit when the source does not provide one. */
  dueAt?: string | null;
  /** When the order was placed at the source; omit when the adapter does not read it. */
  placedAt?: string | null;
  /** Source-reported order total, including tax; null when the source does not report one. */
  total?: Money | null;
  /**
   * The source customer who placed the order; null for guest orders, omitted when the adapter
   * does not read it. Customer references are personal data: sync stores them only in the
   * erasable customer store, so they must be removed before an observation is recorded.
   */
  customer?: ExternalId | null;
  status: 'open' | 'completed' | 'cancelled' | 'unknown';
  paymentStatus:
    | 'pending'
    | 'authorized'
    | 'paid'
    | 'partially_refunded'
    | 'refunded'
    | 'failed'
    | 'unknown';
  lines: {
    id: ExternalId;
    sku: ExternalId | null;
    /** Originally ordered units, including units subsequently removed. */
    quantity: Quantity;
    /** Current units excluding removals and refunds; omitted or null when not reported. */
    currentQuantity?: Quantity | null;
    /** Reduced units, including removals or refunds; null when the source does not report them. */
    cancelledQuantity: Quantity | null;
    /** SKU text on the source line. It describes the line but never establishes SKU identity. */
    skuCode?: string | null;
    /** Line title at the source when the order was read. */
    title?: string | null;
  }[];
}

export interface InventorySnapshot {
  sku: ExternalId;
  location: ExternalId;
  unit: string;
  onHand: string | null;
  reserved: string | null;
  available: string | null;
  availabilityBasis: 'provider_reported' | 'derived' | 'unknown';
}

export interface FulfillmentSnapshot {
  order: ExternalId;
  status:
    | 'pending'
    | 'processing'
    | 'completed'
    | 'shipped'
    | 'delivered'
    | 'cancelled'
    | 'failed'
    | 'unknown';
  lines: {
    orderLine: ExternalId;
    /** Total work (including zero after removal) or positive shipped units. */
    quantity: Quantity;
    /** Outstanding work reported by the provider; omitted or null when not read. */
    remainingQuantity?: Quantity | null;
  }[];
  lastProgressAt: string | null;
  progressBasis?: 'note_created_or_package_shipped' | 'source_updated';
  failureCode: string | null;
  /**
   * Work to fulfill (such as a Shopify fulfillment order) or a shipment that left a location.
   * Omit when the adapter does not distinguish them.
   */
  kind?: FulfillmentKind | null;
  /** Holds that stop the work; empty when none. Omit when the adapter does not read holds. */
  holds?: { reason: FulfillmentHoldReason }[];
  /** The assigned or shipping location. The name is descriptive only. */
  location?: { id: ExternalId; name: string | null } | null;
  /** The source schedules the work to start at this time. */
  fulfillAt?: string | null;
  /** The source's deadline for fulfilling the work. */
  fulfillBy?: string | null;
  /** The carrier's or source's delivery estimate for a shipment. */
  estimatedDeliveryAt?: string | null;
  /** How the customer receives the items, with the method name shown at checkout. */
  method?: { type: FulfillmentMethodType; name: string | null } | null;
  /** Carrier tracking for a shipment. Entries may lack a number or link. */
  tracking?: FulfillmentTracking[];
  /** The latest carrier-reported delivery state of a shipment; null when none is reported. */
  delivery?: FulfillmentDelivery | null;
}

export type FulfillmentKind = 'fulfillment_order' | 'shipment';

export type FulfillmentHoldReason =
  | 'awaiting_payment'
  | 'high_risk_of_fraud'
  | 'incorrect_address'
  | 'inventory_out_of_stock'
  | 'unknown_delivery_date'
  | 'awaiting_return_items'
  | 'other';

export type FulfillmentMethodType =
  | 'shipping'
  | 'pick_up'
  | 'pickup_point'
  | 'local'
  | 'retail'
  | 'none'
  | 'unknown';

export type FulfillmentDelivery =
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'attempted_delivery'
  | 'delayed'
  | 'ready_for_pickup'
  | 'delivered'
  | 'failed';

export interface FulfillmentTracking {
  carrier: string | null;
  number: string | null;
  /** An absolute http(s) tracking link. */
  url: string | null;
}

/**
 * A source list price. `currency` is null when the source reports an amount without its
 * currency; such prices are shown but never compared.
 */
export interface ListPrice {
  /** Decimal string with at most six fractional and fourteen integer digits. */
  amount: string;
  currency: string | null;
}

/**
 * A product and its variants as the source reports them. Optional fields are omitted when the
 * adapter does not read them; null means the source did not report a value.
 */
export interface ProductSnapshot {
  title: string | null;
  status: 'active' | 'draft' | 'archived' | 'unknown';
  /** Brand or manufacturer text; descriptive only. */
  vendor?: string | null;
  /**
   * Whether the source offers the product on its own sales channel: Shopify's Online Store
   * publication, JTL's shop activation.
   */
  published?: boolean | null;
  skus: {
    id: ExternalId;
    code: string | null;
    unit: string;
    /** Variant title, for example a size or colour; null for a product's only variant. */
    title?: string | null;
    price?: ListPrice | null;
    /** GTIN, EAN or UPC text; descriptive only. */
    barcode?: string | null;
  }[];
}

/**
 * A customer profile as the source reports it. Contact and address fields are null unless the
 * source shared them; `shared` records which protected groups this read was allowed to include.
 */
export interface CustomerSnapshot {
  displayName: string | null;
  email: string | null;
  phone: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  state: 'enabled' | 'disabled' | 'invited' | 'declined' | 'unknown';
  /** When the customer was created at the source. */
  createdAt: string | null;
  orderCount: number | null;
  amountSpent: Money | null;
  tags: string[];
  shared: { contact: boolean; address: boolean };
}

/**
 * A return as the source reports it. Quantities are decimal strings. Receipt quantities are null
 * when the source does not report what came back.
 */
export interface ReturnSnapshot {
  type: 'return';
  order: ExternalId;
  /** Source return name, for example `#1001-R1`. */
  name: string | null;
  status:
    'requested' | 'open' | 'closed' | 'declined' | 'cancelled' | 'unknown';
  /** When the return was requested or created at the source. */
  requestedAt: string | null;
  approvedAt: string | null;
  /** When the source closed, declined or cancelled the return. */
  closedAt: string | null;
  declineReason: 'return_period_ended' | 'final_sale' | 'other' | null;
  /** Latest time the source recorded returned items as received. */
  receivedAt: string | null;
  lines: {
    /** Null when the source line is not tied to an order line. */
    orderLine: ExternalId | null;
    quantity: Quantity;
    /** Source reason label. Free-text notes are not read. */
    reason: string | null;
    /** Units received back, whether restocked or not. */
    receivedQuantity: string | null;
    restockedQuantity: string | null;
    /** Units the source reports as refunded. */
    refundedQuantity: string | null;
    /** Value of the returned units after discounts, as reported by the source. */
    value: Money | null;
  }[];
}

/** A refund payment attempt. Only `success` means money was returned. */
export interface RefundTransaction {
  status: 'success' | 'pending' | 'failed' | 'unknown';
  amount: Money;
  processedAt: string | null;
  /** Payment gateway name, for example `shopify_payments`; descriptive only. */
  gateway: string | null;
}

/**
 * A refund recorded at the source. `total` is the source-reported amount; the transactions
 * establish whether money was actually returned.
 */
export interface RefundSnapshot {
  type: 'refund';
  order: ExternalId;
  /** The return this refund settles, when the source links one. */
  return: ExternalId | null;
  createdAt: string | null;
  total: Money | null;
  lines: {
    orderLine: ExternalId;
    quantity: Quantity;
    restock: 'return' | 'cancel' | 'no_restock' | 'unknown';
    restocked: boolean;
  }[];
  transactions: RefundTransaction[];
}

/** Acceptance is not proof that the expected business state was reached. */
export interface WriteReceipt {
  status: 'accepted';
  evidenceRefs: string[];
  providerRequestId: string | null;
}

/** A supplier in the merchant's purchasing system. Contact details are descriptive only. */
export interface SupplierSnapshot {
  name: string | null;
  /** Merchant-assigned supplier number. */
  number: string | null;
  active: boolean | null;
  email: string | null;
}

export type SupplierOrderStatus =
  | 'open'
  | 'released'
  | 'in_progress'
  | 'partially_delivered'
  | 'overdue'
  | 'completed'
  | 'unknown';

/**
 * A purchase order as the purchasing system records it. Confirmation fields are what the
 * system holds about the supplier's confirmation; delivered quantities are booked goods
 * receipts. Null means the source holds no value.
 */
export interface SupplierOrderSnapshot {
  supplier: ExternalId;
  /** The source's own order number. */
  orderNumber: string | null;
  /** The Luma purchase-order ID this order was created for, when Luma created it. */
  lumaOrderId: string | null;
  status: SupplierOrderStatus;
  /** Calendar date (YYYY-MM-DD) requested from the supplier. */
  requestedDeliveryDate: string | null;
  /** Whether the order as a whole is recorded as confirmed by the supplier. */
  confirmed: boolean | null;
  createdAt: string | null;
  lines: {
    id: ExternalId;
    sku: ExternalId | null;
    /** Source item number text; descriptive only. */
    itemNumber: string | null;
    quantity: Quantity;
    /** Units booked as received at the warehouse. */
    deliveredQuantity: string | null;
    confirmedQuantity: string | null;
    /** Calendar date (YYYY-MM-DD) the supplier confirmed. */
    confirmedDeliveryDate: string | null;
    confirmed: boolean | null;
    requestedDeliveryDate: string | null;
  }[];
}

/** Creates one purchase order in the purchasing system for an approved Luma order. */
export interface PurchaseOrderSubmission {
  /** The Luma purchase-order ID; the adapter stores it so the order can be found again. */
  lumaOrderId: string;
  /** Buyer reference shown to the supplier. */
  reference: string;
  supplier: ExternalId;
  /** Calendar date (YYYY-MM-DD). */
  requestedDeliveryDate: string;
  lines: { sku: ExternalId; quantity: Quantity }[];
}

export interface ShippingMethodSnapshot {
  orderStatus: 'open' | 'shipped' | 'cancelled' | 'unknown';
  shippingMethod: ExternalId;
  isCancelled: boolean;
}

/** A recovery command is bound to an exact provider record and reviewed revision. */
export interface FulfillmentRecoveryInput {
  orderId: string;
  fulfillmentOrderId: string;
  expectedRevision: string;
  holdId?: string;
  locationId?: string;
}

/**
 * Which messages a mailbox read returns. A message matches when any condition matches; an
 * empty filter matches nothing. Adapters apply it at the provider, so Luma never receives
 * messages outside it.
 */
export interface MailboxFilter {
  /** Lower-case sender domains; subdomains match too. */
  senderDomains: string[];
  /** Lower-case sender addresses. */
  senderAddresses: string[];
  /** Lower-case recipient addresses (to or cc), such as an alias delivered to the mailbox. */
  recipientAddresses: string[];
  /** Provider label or folder names. */
  labels: string[];
  /** Also return messages the mailbox sent to the listed domains and addresses. */
  includeSent: boolean;
}

export interface MessageAddress {
  /** Lower-case address. */
  address: string;
  name: string | null;
}

export interface MessageAttachmentRef {
  attachment: ExternalId;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * One message as the mailbox holds it. Messages are personal data: they are stored only by the
 * messaging owner, never as commerce observations.
 */
export interface MessageSnapshot {
  thread: ExternalId;
  /** RFC 5322 Message-ID without angle brackets. */
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Relative to the connected mailbox. */
  direction: 'inbound' | 'outbound';
  from: MessageAddress;
  to: MessageAddress[];
  cc: MessageAddress[];
  replyTo: MessageAddress[];
  subject: string;
  /** Plain text; HTML-only bodies are converted. At most 100,000 characters. */
  text: string;
  truncated: boolean;
  /** The Date header, or the provider's time when the header is missing or invalid. */
  sentAt: string;
  /** When the mailbox received or sent the message, on the provider's clock. */
  receivedAt: string;
  labels: string[];
  attachments: MessageAttachmentRef[];
}

export interface AttachmentContent {
  filename: string;
  mimeType: string;
  size: number;
  /** Lower-case hex SHA-256 of the decoded content. */
  sha256: string;
  base64: string;
}

/** A reply or new message Luma asks the mailbox to send. */
export interface OutboundMessage {
  /**
   * Luma's outbound ID. Adapters derive the RFC Message-ID from it and refuse to send when the
   * mailbox already holds a message with that ID.
   */
  outboundId: string;
  thread: ExternalId | null;
  inReplyTo: string | null;
  references: string[];
  to: MessageAddress[];
  cc: MessageAddress[];
  subject: string;
  text: string;
}

export interface CapabilityContract {
  /** Corrects one approved item/location's available stock using provider CAS and idempotency. */
  'inventory.available.reconcile': {
    input: {
      inventoryItemId: string;
      locationId: string;
      expectedRevision: string;
      expectedAvailable: number;
      available: number;
    };
    output: WriteReceipt;
  };
  'fulfillment.hold.release': {
    input: FulfillmentRecoveryInput;
    output: WriteReceipt;
  };
  'fulfillment.open': { input: FulfillmentRecoveryInput; output: WriteReceipt };
  'fulfillment.move': { input: FulfillmentRecoveryInput; output: WriteReceipt };
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
  'orders.read': { input: PageQuery; output: Page<OrderSnapshot> };
  'suppliers.read': {
    input: PageQuery & { supplier?: ExternalId };
    output: Page<SupplierSnapshot>;
  };
  /**
   * Reads purchase orders by source ID, or finds the orders created for a Luma purchase order
   * at or after `createdSince`. Resource `purchase_order`.
   */
  'purchase-orders.read': {
    input: PageQuery & {
      order?: ExternalId;
      created?: { lumaOrderId: string; createdSince: string };
    };
    output: Page<SupplierOrderSnapshot>;
  };
  /** Acceptance means the purchasing system recorded the order, not that a supplier saw it. */
  'purchase-orders.submit': {
    input: PurchaseOrderSubmission;
    output: WriteReceipt;
  };
  'orders.write': {
    input: { order: ExternalId; operation: 'cancel'; expectedRevision: string };
    output: WriteReceipt;
  };
  'inventory.read': {
    input: PageQuery & { sku?: ExternalId; location?: ExternalId };
    output: Page<InventorySnapshot>;
  };
  'inventory.write': {
    input: {
      sku: ExternalId;
      location: ExternalId;
      available: Quantity;
      expectedRevision: string;
    };
    output: WriteReceipt;
  };
  'fulfillment.read': {
    input: PageQuery & { order?: ExternalId };
    output: Page<FulfillmentSnapshot>;
  };
  'fulfillment.retry': {
    input: { fulfillment: ExternalId; expectedRevision: string };
    output: WriteReceipt;
  };
  'products.read': { input: PageQuery; output: Page<ProductSnapshot> };
  'customers.read': { input: PageQuery; output: Page<CustomerSnapshot> };
  /** Returns and refunds per order; the observation resource is `return` or `refund`. */
  'returns.read': {
    input: PageQuery & { order?: ExternalId };
    output: Page<ReturnSnapshot | RefundSnapshot>;
  };
  /** Messages matching `filter` received at or after `receivedSince`. Resource `message`. */
  'messages.read': {
    input: PageQuery & { filter: MailboxFilter; receivedSince: string };
    output: Page<MessageSnapshot>;
  };
  /** Every message of one thread, for refreshing a thread and verifying sends. */
  'message-threads.read': {
    input: PageQuery & { thread: ExternalId };
    output: Page<MessageSnapshot>;
  };
  /** Reads one attachment; fails with `invalid_request` above `maxBytes`. */
  'message-attachments.read': {
    input: { message: ExternalId; attachment: ExternalId; maxBytes: number };
    output: AttachmentContent;
  };
  /** Acceptance means the provider accepted the message, not that anyone received it. */
  'messages.send': { input: OutboundMessage; output: WriteReceipt };
}

export type Capability = keyof CapabilityContract;

export type ReadCapability = Extract<Capability, `${string}.read`>;

export type WriteCapability = Exclude<Capability, ReadCapability>;

export type CapabilityInput<K extends Capability> =
  CapabilityContract[K]['input'];

export type CapabilityOutput<K extends Capability> =
  CapabilityContract[K]['output'];

export type CapabilityResult<K extends Capability> =
  | { ok: true; value: CapabilityOutput<K> }
  | { ok: false; error: ConnectorFailure };
