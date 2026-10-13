import type {
  ProviderContext,
  RecordQuery,
  StoredRecord,
} from '@luma/simulator-core';

import type {
  ShopifyConfig,
  ShopifyHoldReason,
  ShopifyInventoryShipment,
  ShopifyInventoryTransfer,
} from './types.js';

/** Execution context of one Shopify request or command. */
export type ShopifyContext = ProviderContext<ShopifyConfig>;

export type FulfillmentOrderStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'CANCELLED'
  | 'INCOMPLETE'
  | 'CLOSED'
  | 'SCHEDULED'
  | 'ON_HOLD';

/** Shopify orders; `customer` and `location` are numeric record IDs. */
export interface OrderData {
  number: number;
  name: string;
  customer: string | null;
  /** Location of the open fulfillment work; moves with it. */
  location: string;
  shipping: 'standard' | 'express';
  currency: string;
  displayFinancialStatus:
    | 'PENDING'
    | 'AUTHORIZED'
    | 'PARTIALLY_PAID'
    | 'PAID'
    | 'PARTIALLY_REFUNDED'
    | 'REFUNDED'
    | 'VOIDED';
  displayFulfillmentStatus: 'UNFULFILLED' | 'PARTIALLY_FULFILLED' | 'FULFILLED';
  cancelledAt: string | null;
  cancelReason: string | null;
  closed: boolean;
  /** Order total in minor units. */
  total: number;
  /** Successfully refunded amount in minor units. */
  refunded: number;
  /**
   * Shipping charges in minor units. Orders stored before charges were recorded have one free
   * charge for their shipping speed.
   */
  shippingLines?: OrderShippingLineData[];
  /** Discounts across line items; line prices are already after them. */
  discounts?: OrderDiscountData[];
  tags?: string[];
  /** The customer's currency and its rate per shop currency unit; the shop currency when absent. */
  presentment?: { currency: string; rate: number } | null;
  /** Delivery address; orders stored before addresses were recorded use the customer's address. */
  shippingAddress?: OrderAddressData | null;
  billingAddress?: OrderAddressData | null;
  /** Whether a merchant edited the order after it was placed. */
  edited?: boolean;
}

interface OrderShippingLineData {
  id: string;
  title: string;
  code: string;
  /** Charge in minor units. */
  price: number;
  removed: boolean;
}

interface OrderDiscountData {
  kind: 'code' | 'automatic';
  /** Discount code or automatic discount title. */
  label: string;
  percentage: number;
}

interface OrderAddressData {
  address1: string;
  city: string;
  zip: string;
  countryCode: string;
}

export interface LineItemData {
  order: string;
  variant: string | null;
  product: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  /** Missing on records stored before order edits were supported. */
  currentQuantity?: number;
  /** Unit price in minor units, after the order's discounts. */
  price: number;
  /** Unit price before discounts in minor units; `price` when absent. */
  originalPrice?: number;
  /** Variant title when the order was placed; absent for records stored before titles. */
  variantTitle?: string | null;
}

interface FulfillmentHoldData {
  id: string;
  reason: ShopifyHoldReason;
  heldByRequestingApp: boolean;
}

export interface FulfillmentOrderData {
  order: string;
  location: string;
  status: FulfillmentOrderStatus;
  requestStatus: 'UNSUBMITTED';
  fulfillAt: string | null;
  fulfillBy: string | null;
  holds: FulfillmentHoldData[];
  /** Status restored when the last hold is released. */
  heldStatus: FulfillmentOrderStatus | null;
  method: { name: string; maxDeliveryAt: string | null };
}

export interface FulfillmentOrderLineItemData {
  fulfillmentOrder: string;
  lineItem: string;
  totalQuantity: number;
  remainingQuantity: number;
}

export interface FulfillmentData {
  order: string;
  fulfillmentOrder: string;
  location: string;
  status: 'SUCCESS' | 'FAILURE' | 'CANCELLED';
  displayStatus: string;
  inTransitAt: string | null;
  deliveredAt: string | null;
  estimatedDeliveryAt: string | null;
  tracking: { company: string; number: string; url: string }[];
}

export interface FulfillmentLineItemData {
  fulfillment: string;
  lineItem: string;
  quantity: number;
}

export interface ReturnData {
  order: string;
  name: string;
  status: 'REQUESTED' | 'OPEN' | 'CLOSED' | 'DECLINED' | 'CANCELED';
  requestApprovedAt: string | null;
  closedAt: string | null;
  declineReason: 'RETURN_PERIOD_ENDED' | null;
}

export interface ReturnLineItemData {
  return: string;
  fulfillmentLineItem: string;
  lineItem: string;
  quantity: number;
  refundedQuantity: number;
  processedQuantity?: number;
  returnReasonNote?: string | null;
  reason: string;
  /** Value of the returned units in minor units. */
  amount: number;
}

/** A requested replacement; inventory and fulfillment start only when the return is processed. */
export interface ExchangeLineItemData {
  return: string;
  order: string;
  variant: string;
  quantity: number;
  processedQuantity: number;
  /** Price fixed by the native request, in minor units. */
  price: number;
  lineItems: string[];
}

export interface ReverseFulfillmentOrderData {
  return: string;
  status: 'OPEN' | 'CLOSED' | 'CANCELED';
}

export interface ReverseFulfillmentOrderLineItemData {
  reverseFulfillmentOrder: string;
  returnLineItem: string;
  fulfillmentLineItem: string;
  totalQuantity: number;
  dispositions: {
    id: string;
    type: 'RESTOCKED' | 'NOT_RESTOCKED' | 'MISSING';
    quantity: number;
    createdAt: string;
  }[];
}

export interface RefundData {
  note?: string | null;
  order: string;
  return: string | null;
  /** Requested amount in minor units. */
  amount: number;
  /** Amount whose payment succeeded, in minor units. */
  total: number;
}

export interface RefundLineItemData {
  refund: string;
  lineItem: string;
  quantity: number;
  restockType: 'RETURN' | 'CANCEL' | 'NO_RESTOCK';
  restocked: boolean;
}

/** Payment transactions; refund transactions use the refund ID as record key. */
export interface OrderTransactionData {
  order: string;
  refund: string | null;
  parent: string | null;
  kind: 'SALE' | 'REFUND';
  status: 'SUCCESS' | 'PENDING' | 'FAILURE';
  gateway: string;
  /** Amount in minor units. */
  amount: number;
  processedAt: string | null;
}

export interface BasicEventData {
  order: string;
  action: string;
}

export interface CustomerData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: { address1: string; city: string; zip: string; countryCode: string };
  state: 'ENABLED' | 'DISABLED' | 'INVITED' | 'DECLINED';
  tags: string[];
  numberOfOrders: number;
  /** Lifetime spend in minor units. */
  amountSpent: number;
}

export interface ProductData {
  title: string;
  vendor: string;
  productType: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  publishedAt: string | null;
  /** Lowest variant price in minor units. */
  minPrice: number;
}

export interface ProductVariantData {
  product: string;
  sku: string;
  title: string;
  /** Price in minor units. */
  price: number;
  barcode: string | null;
}

/** Inventory items share the numeric ID of their variant. */
export interface InventoryItemData {
  variant: string;
  product: string;
  sku: string;
  tracked: boolean;
}

/** Stock of one item at one location; available is on hand minus committed. */
export interface InventoryLevelData {
  item: string;
  location: string;
  onHand: number;
  committed: number;
  reserved?: number;
  incoming?: number;
  damaged?: number;
  qualityControl?: number;
  safetyStock?: number;
  /** Item activation is independent of the location activity. */
  isActive?: boolean;
}

export interface WebhookSubscriptionData {
  /** GraphQL topic name, such as `ORDERS_CREATE`. */
  topic: string;
  uri: string;
  format: string;
}

/** Persisted adjustment facts retain exact target identities for independent filtered reads. */
export interface InventoryAdjustmentGroupData {
  reason: string;
  referenceDocumentUri: string | null;
  changes: {
    inventoryItemId: string;
    locationId: string;
    name: string;
    delta: number;
    quantityAfterChange: number;
  }[];
}

/** A quantity change staged in an order edit session. */
interface StagedQuantityData {
  lineItem: string;
  /** Target current quantity of the line. */
  quantity: number;
  restock: boolean;
  /** Current quantity when the change was staged; a commit refuses lines changed since. */
  from: number;
}

/** An API order edit between `orderEditBegin` and `orderEditCommit`; the order is unchanged until commit. */
export interface OrderEditSessionData {
  order: string;
  state: 'open' | 'committed';
  changes: StagedQuantityData[];
}

/** One changed line of an order edit; removed units have negative quantities. */
export interface OrderEditSaleData {
  id: string;
  lineItem: string;
  quantity: number;
  actionType: 'ORDER' | 'RETURN';
}

/** The sales agreement Shopify records for a committed order edit. */
export interface OrderEditAgreementData {
  order: string;
  happenedAt: string;
  /** App GID of the editing app; null for a staff edit in Shopify admin. */
  app: string | null;
  staffNote: string | null;
  notifyCustomer: boolean;
  sales: OrderEditSaleData[];
}

/** Stored response of an idempotent mutation. */
export interface IdempotencyKeyData {
  input: string;
  result: unknown;
}

export const dayMs = 86_400_000;

/** The app GID of this simulator's installation; agreements of API order edits name it. */
export const simulatorAppId = 'gid://shopify/App/1';

/**
 * Orders created before the returned time are hidden without `read_all_orders`; Shopify then
 * exposes the last 60 days. Undefined when the whole history is visible.
 */
export function historyStart(context: ShopifyContext) {
  return context.config.scopes.includes('read_all_orders')
    ? undefined
    : context.now - 60 * dayMs;
}

/** Whether an order is visible to the installation's granted order history. */
export function visibleOrder(context: ShopifyContext, order: StoredRecord) {
  const start = historyStart(context);

  return start === undefined || order.createdAt >= start;
}

/**
 * A merchant or API action that Shopify refuses in the current state. `field` names the
 * mutation argument a user error points to, when the refusal concerns one.
 */
export class RuleError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** Formats a Shopify global ID. */
export const gid = (type: string, id: string) => `gid://shopify/${type}/${id}`;

/** Parses a Shopify global ID, optionally requiring a resource type. */
export function parseGid(value: unknown, type?: string) {
  if (typeof value !== 'string') return undefined;
  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/([0-9]{1,18})(\?.*)?$/.exec(
    value,
  );
  const [, kind, id, query = ''] = match ?? [];
  if (!kind || !id || (type && kind !== type)) return undefined;

  return { type: kind, id, query };
}

/** Formats simulation time as Shopify does, in UTC with whole seconds. */
export const iso = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Parses a shop-currency decimal string into minor units. */
export function minorUnits(value: string) {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Invalid price ${value}`);

  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Formats minor units as Shopify's `Decimal`, such as `24.0` or `19.99`. */
export function decimal(value: number) {
  const fraction = String(Math.abs(value) % 100)
    .padStart(2, '0')
    .replace(/0$/, '');

  return `${value < 0 ? '-' : ''}${Math.trunc(Math.abs(value) / 100)}.${fraction || '0'}`;
}

/** Formats minor units as Shopify's `Money` scalar, such as `24.00`. */
export const money = (value: number) => (value / 100).toFixed(2);

/** Builds a `MoneyBag` in the shop currency. */
export const moneyBag = (value: number, currency: string) => ({
  shopMoney: { amount: decimal(value), currencyCode: currency },
  presentmentMoney: { amount: decimal(value), currencyCode: currency },
});

/**
 * Builds a `MoneyBag` of an order amount: the shop currency, and the customer's currency at
 * the order's rate, rounded to minor units, when the order was presented in another currency.
 */
export const orderMoneyBag = (value: number, order: OrderData) => ({
  shopMoney: { amount: decimal(value), currencyCode: order.currency },
  presentmentMoney: order.presentment
    ? {
        amount: decimal(Math.round(value * order.presentment.rate)),
        currencyCode: order.presentment.currency,
      }
    : { amount: decimal(value), currencyCode: order.currency },
});

/** Store ID of an inventory level. */
export const levelId = (item: string, location: string) =>
  `${item}.${location}`;

/** Shopify's inventory level ID: the location number qualified by the inventory item. */
export const levelGid = (item: string, location: string) =>
  `${gid('InventoryLevel', location)}?inventory_item_id=${item}`;

/** Allocates a numeric record ID; one sequence keeps IDs unique across record types. */
export async function nextId(context: ShopifyContext) {
  return String(await context.store.sequence('id', 100_000_001));
}

/** Inserts or replaces a record changed at the context's simulation time. */
export async function save<T>(
  context: ShopifyContext,
  kind: string,
  id: string,
  data: T,
  meta: { parent?: string | null; key?: string | null; created?: boolean } = {},
) {
  await context.store.put(kind, id, data, {
    ...(meta.parent === undefined ? {} : { parent: meta.parent }),
    ...(meta.key === undefined ? {} : { key: meta.key }),
    ...(meta.created ? { createdAt: context.now } : {}),
    updatedAt: context.now,
  });
}

/** Builds a new record for `putMany`, created at the context's simulation time. */
export const insert = (
  context: ShopifyContext,
  kind: string,
  id: string,
  data: unknown,
  meta: { parent?: string | null; key?: string | null } = {},
) => ({
  kind,
  id,
  data,
  parent: meta.parent ?? null,
  key: meta.key ?? null,
  createdAt: context.now,
  updatedAt: context.now,
});

/** Reads a record or fails with a merchant-readable message. */
export async function load<T>(
  context: ShopifyContext,
  kind: string,
  id: string,
  label = kind,
) {
  const record = await context.store.get<T>(kind, id);
  if (!record) throw new Error(`${label} ${id} not found`);

  return record;
}

/** Reads every record of a query in pages; for bounded child collections. */
export async function all<T>(
  context: ShopifyContext,
  query: Omit<RecordQuery, 'limit' | 'after'>,
) {
  const records: StoredRecord<T>[] = [];
  let after: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof context.store.page<T>>> =
      await context.store.page<T>({ ...query, after, limit: 250 });
    records.push(...page.items);
    after = page.next;
  } while (after);

  return records;
}

/** Sends a webhook notification with Shopify's minimal resource payload. */
export function notify(
  context: ShopifyContext,
  topic: string,
  type: string,
  id: string,
  payload: Record<string, unknown> = {},
) {
  const resource = gid(type, id);
  context.notify({
    topic,
    resource,
    payload: {
      id: Number(id),
      admin_graphql_api_id: resource,
      updated_at: iso(context.now),
      ...payload,
    },
  });
}

/** Finds a configured location by numeric ID. */
export function location(context: ShopifyContext, id: string) {
  return context.config.locations.find((candidate) => candidate.id === id);
}

/** GraphQL `Location` for a configured location; simulated locations are always active. */
export function locationNode(context: ShopifyContext, id: string) {
  const found = location(context, id);

  return found
    ? {
        __typename: 'Location',
        id: gid('Location', found.id),
        name: found.name,
        isActive: true,
      }
    : null;
}

export type InventoryTransferData = Omit<
  ShopifyInventoryTransfer,
  'id' | 'lines' | 'shipments'
> & { shipmentIds: string[] };

export type InventoryTransferLineData =
  ShopifyInventoryTransfer['lines'][number];

export type InventoryShipmentData = Omit<
  ShopifyInventoryShipment,
  'id' | 'lines'
> & { linesAvailable: boolean };

export type InventoryShipmentLineData = NonNullable<
  ShopifyInventoryShipment['lines']
>[number];
