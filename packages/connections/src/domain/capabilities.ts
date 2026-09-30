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
    | 'customer';
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
  displayNumber: string | null;
  /** Source-provided fulfillment deadline; omit when the source does not provide one. */
  dueAt?: string | null;
  /** When the order was placed at the source; omit when the adapter does not read it. */
  placedAt?: string | null;
  /** Source-reported order total, including tax; null when the source does not report one. */
  total?: Money | null;
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
    quantity: Quantity;
    /** Null when the source cannot distinguish cancellations from refunds or edits. */
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
  lines: { orderLine: ExternalId; quantity: Quantity }[];
  lastProgressAt: string | null;
  progressBasis?: 'note_created_or_package_shipped' | 'source_updated';
  failureCode: string | null;
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

/** Acceptance is not proof that the expected business state was reached. */
export interface WriteReceipt {
  status: 'accepted';
  evidenceRefs: string[];
  providerRequestId: string | null;
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

export interface CapabilityContract {
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
