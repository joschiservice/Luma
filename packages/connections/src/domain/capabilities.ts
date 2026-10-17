import type { ConnectorFailure } from '@luma/connector-core';

import type { OrderBundleGroup, ProductBundle } from './bundles.js';
import type { CatalogCapabilities } from './catalog-capabilities.js';
import type { FulfillmentCapabilities } from './fulfillment-capabilities.js';
import type { InventoryCapabilities } from './inventory-capabilities.js';
import type { MessageCapabilities } from './message-capabilities.js';
import type { OrderCapabilities } from './order-capabilities.js';
import type { PurchasingCapabilities } from './purchasing-capabilities.js';
import type { ReturnCapabilities } from './return-capabilities.js';

export { ConnectorError } from '@luma/connector-core';

export type { ConnectorFailure } from '@luma/connector-core';

export type {
  InventoryShipmentSnapshot,
  InventoryTransferSnapshot,
} from './inventory-transfers.js';

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
    | 'message'
    | 'return_reason'
    | 'inventory_transfer'
    | 'inventory_shipment';
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
  /** Point lookup to confirm a previously observed record missing from a complete scan. */
  confirmMissing?: ExternalId & { createdAt: string | null };
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
  /** Absence confirmation; only `deleted` supplies an independently read tombstone. */
  confirmation?: 'present' | 'missing' | 'history_limited' | 'deleted';
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
interface Money {
  /** Decimal string with at most six fractional and fourteen integer digits. */
  amount: string;
  currency: string;
}

/** An amount in the shop's currency and in the currency the customer was charged in. */
export interface MoneyPair {
  shop: Money;
  presentment: Money;
}

/**
 * An order amount as originally placed and as it currently stands after edits, refunds and
 * returns. Either is null when the source does not report it.
 */
interface OrderAmount {
  original: MoneyPair | null;
  current: MoneyPair | null;
}

/** A postal address as the source reported it; every field may be absent. */
export interface OrderAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/**
 * Commercial and delivery facts of an order as the source reports them. Amounts are exact
 * decimal strings and are never recomputed from lines or converted between currencies.
 */
export interface OrderCommercialFacts {
  /** The shop's currency and the currency the customer was charged in. */
  currencies?: { shop: string | null; presentment: string | null };
  amounts?: {
    subtotal: OrderAmount;
    shipping: OrderAmount;
    discounts: OrderAmount;
    tax: OrderAmount;
    duties: OrderAmount;
    total: OrderAmount;
  };
  /** Whether the order's prices include tax and duties; null when not reported. */
  taxesIncluded?: boolean | null;
  dutiesIncluded?: boolean | null;
  /** Current tax lines. `rate` is fractional (0.19 means 19%). */
  taxLines?: {
    title: string | null;
    rate: string | null;
    amount: MoneyPair | null;
  }[];
  /** Shipping charges, including removed ones. `current` is null for a removed charge. */
  shippingLines?: {
    id: string | null;
    title: string | null;
    code: string | null;
    source: string | null;
    carrier: string | null;
    removed: boolean | null;
    original: MoneyPair | null;
    discounted: MoneyPair | null;
    current: MoneyPair | null;
  }[];
  /** Discounts applied to the order. Labels are codes or titles; descriptions are not read. */
  discounts?: {
    index: number | null;
    kind: 'code' | 'automatic' | 'manual' | 'script' | 'unknown';
    label: string | null;
    target: 'line_item' | 'shipping_line' | 'unknown';
    allocation: 'across' | 'each' | 'unknown';
    value:
      | { type: 'percentage'; percentage: string }
      | { type: 'fixed'; amount: Money }
      | null;
  }[];
  /** Merchant labels on the order. */
  tags?: string[];
  /** Operational facts the source reports about the order. */
  attributes?: {
    edited: boolean | null;
    requiresShipping: boolean | null;
    test: boolean | null;
    cancelReason:
      | 'customer'
      | 'declined'
      | 'fraud'
      | 'inventory'
      | 'staff'
      | 'other'
      | 'unknown'
      | null;
    cancelledAt: string | null;
    closedAt: string | null;
    processedAt: string | null;
    /** Sales channel label, such as `web` or `pos`. */
    channel: string | null;
    /**
     * The source's own fulfillment status label, lowercased, such as `partially_fulfilled`.
     * It is the source's report, not Luma's fulfillment state.
     */
    fulfillmentStatus: string | null;
  };
}

export interface OrderSnapshot extends OrderCommercialFacts {
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
  /**
   * Delivery and billing addresses. Protected personal data like `customer`: sync stores them
   * only in the erasable customer store and removes them before the observation is recorded.
   * `shared` is false when the deployment is not approved to read addresses; omitted when the
   * adapter does not read them. A null address means the order has none.
   */
  addresses?:
    | {
        shared: true;
        shipping: OrderAddress | null;
        billing: OrderAddress | null;
      }
    | { shared: false };
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
    /** Source unit price; absent or null when not reported. */
    unitPrice?: Money | null;
    /**
     * Whether `unitPrice` includes tax, as the source states it; absent or null when unknown.
     * Prices are never converted between net and gross, because a rate can be missing or split.
     */
    taxIncluded?: boolean | null;
    /** Fractional tax rate (0.19 means 19%); absent or null when not reported. */
    taxRate?: string | null;
    /** Exact merchandising group; omitted means unread, null means a standalone line. */
    bundleGroup?: OrderBundleGroup | null;
    /** Line title at the source when the order was read. */
    title?: string | null;
    /** Variant title at the source when the order was read. */
    variantTitle?: string | null;
    /** Unit prices and the line's total discount; absent when the adapter does not read them. */
    prices?: {
      originalUnit: MoneyPair | null;
      /** Unit price after line and order discounts. */
      discountedUnit: MoneyPair | null;
      totalDiscount: MoneyPair | null;
    };
    requiresShipping?: boolean | null;
    /**
     * Whether the line still refers to a catalog variant: `variant_removed` when the variant
     * was deleted but its product remains, `no_product` for a custom item or a deleted product.
     */
    catalog?: 'variant' | 'variant_removed' | 'no_product';
  }[];
}

export interface InventorySnapshot {
  /** Live SKU composition facts; omitted means unread, null means the variant was unavailable. */
  composition?: {
    variant: ExternalId;
    requiresComponents: boolean;
    hasComponents: boolean;
  } | null;
  sku: ExternalId;
  location: ExternalId;
  unit: string;
  onHand: string | null;
  /** Source-reported reservation state; compare only under the same inventory semantics. */
  reserved: string | null;
  available: string | null;
  committed?: string | null;
  incoming?: string | null;
  damaged?: string | null;
  qualityControl?: string | null;
  safetyStock?: string | null;
  locationActive?: boolean | null;
  itemActive?: boolean | null;
  tracked?: boolean | null;
  /** Versioned quantity meaning; absent for earlier or other provider reports. */
  inventorySemantics?: 'shopify/1' | null;
  /** Independently corroborated accepted action; matching current stock does not prove exclusive authorship. */
  writeAttribution?: {
    evidenceId: string;
    adjustmentId: string;
    referenceDocumentUri: string;
    available: string;
    quantityMatches: boolean | null;
  } | null;
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
  /** Exact milestone times reported by the source; absence means unknown. */
  milestones?: {
    pickedAt?: string | null;
    shippedAt?: string | null;
    deliveredAt?: string | null;
  };
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
  /** Source handoff evidence; a label alone cannot establish possession by the carrier. */
  shipping?: {
    stage: 'merchant' | 'warehouse' | 'carrier' | 'delivered' | 'unknown';
    sourceUrl: string | null;
    trackingUpdatedAt: string | null;
  };
}

type FulfillmentKind = 'fulfillment_order' | 'shipment';

type FulfillmentHoldReason =
  | 'awaiting_payment'
  | 'high_risk_of_fraud'
  | 'incorrect_address'
  | 'inventory_out_of_stock'
  | 'unknown_delivery_date'
  | 'awaiting_return_items'
  | 'other';

type FulfillmentMethodType =
  | 'shipping'
  | 'pick_up'
  | 'pickup_point'
  | 'local'
  | 'retail'
  | 'none'
  | 'unknown';

type FulfillmentDelivery =
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'attempted_delivery'
  | 'delayed'
  | 'ready_for_pickup'
  | 'delivered'
  | 'failed';

interface FulfillmentTracking {
  carrier: string | null;
  number: string | null;
  /** An absolute http(s) tracking link. */
  url: string | null;
}

/**
 * A source list price. `currency` is null when the source reports an amount without its
 * currency; such prices are shown but never compared.
 */
interface ListPrice {
  /** Decimal string with at most six fractional and fourteen integer digits. */
  amount: string;
  currency: string | null;
}

/**
 * A product and its variants as the source reports them. Optional fields are omitted when the
 * adapter does not read them; null means the source did not report a value.
 */
/** Supplier-specific product terms observed in a purchasing system, never inferred defaults. */
interface ProductPurchasingTerms {
  supplier: ExternalId;
  sourceRecordId: string;
  complete: boolean;
  supplierArticleNumber: string | null;
  unitPrice: {
    amount: string;
    currency: string | null;
    validFrom: string | null;
  } | null;
  packSize: number | null;
  lineMinimumQuantity: number | null;
  orderMinimumValue: { amount: string; currency: string } | null;
  leadTimeDays: number | null;
  preferred: boolean | null;
}

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
    /** Variant composition; omitted when the source does not report it. */
    bundle?: ProductBundle;
    purchasingTerms?: ProductPurchasingTerms[];
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
interface RefundTransaction {
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

/** A choice the source requires when a return is created there. Descriptive only. */
export interface ReturnOptionSnapshot {
  /** Resource `location` for warehouses, `return_reason` for reasons. */
  kind: 'warehouse' | 'reason';
  name: string | null;
}

/**
 * A return found again at the source for a Luma return case. It is verification evidence,
 * not a canonical return record.
 */
export interface CreatedReturnSnapshot {
  order: ExternalId;
  /** The source's own return number. */
  number: string | null;
  /** The Luma return case this return was created for. */
  lumaCaseId: string;
  createdAt: string | null;
  warehouse: ExternalId | null;
  lines: {
    /** Null when the source line is not tied to an order line. */
    orderLine: ExternalId | null;
    quantity: Quantity;
    reason: ExternalId | null;
  }[];
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

interface MessageAttachmentRef {
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
  /** A structured permanent delivery failure; normal message text is never a bounce signal. */
  deliveryFailure?: {
    originalMessageId: string;
    recipient: string;
    status: string;
  };
  thread: ExternalId;
  /** RFC 5322 Message-ID without angle brackets. */
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Relative to the connected mailbox. */
  direction: 'inbound' | 'outbound';
  /** True only when provider-owned metadata confirms a sent message. */
  providerSent?: boolean;
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

/** Every capability with its input and output, joined from the per-family contracts. */
interface CapabilityContract
  extends
    InventoryCapabilities,
    FulfillmentCapabilities,
    OrderCapabilities,
    PurchasingCapabilities,
    CatalogCapabilities,
    ReturnCapabilities,
    MessageCapabilities {}

export type Capability = keyof CapabilityContract;

export type ReadCapability = Extract<Capability, `${string}.read`>;

export type WriteCapability = Exclude<Capability, ReadCapability>;

/** Mailbox reads. They return personal data and never become commerce observations. */
export type MessageReadCapability =
  'messages.read' | 'message-threads.read' | 'message-attachments.read';

export type CapabilityInput<K extends Capability> =
  CapabilityContract[K]['input'];

export type CapabilityOutput<K extends Capability> =
  CapabilityContract[K]['output'];

export type CapabilityResult<K extends Capability> =
  | { ok: true; value: CapabilityOutput<K> }
  | { ok: false; error: ConnectorFailure };
