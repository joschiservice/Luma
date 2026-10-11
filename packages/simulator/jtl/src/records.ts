import type { ProviderContext } from '@luma/simulator-core';

import type { JtlConfig, SupplierProfile } from './types.js';

export type JtlContext = ProviderContext<JtlConfig>;

/** Record kinds in the JTL record store. Each instance numbers its records independently. */
export const kinds = {
  item: 'item',
  /** Item supplier assignments; parent is the item ID and key the supplier ID. */
  assignment: 'item-supplier',
  supplier: 'supplier',
  /** Sales orders; key is `open` while units remain to ship on an uncancelled order. */
  order: 'sales-order',
  /** Delivery notes; parent is the sales-order ID. */
  note: 'delivery-note',
  purchaseOrder: 'purchase-order',
  /** Customers; key is the lowercased email address the order integration matches on. */
  customer: 'customer',
  /** Recorded purchase-order POST results, by Idempotency-Key. */
  purchaseOrderKey: 'purchase-order-key',
} as const;

/** Store key that marks sales orders with open units. */
export const OPEN = 'open';

/** Store key that marks active suppliers, which the supplier overview lists. */
export const ACTIVE = 'active';

/** A catalog item with its physical stock per warehouse. */
export interface ItemRecord {
  id: string;
  sku: string;
  name: string;
  unit: string;
  /** Gross sales price. */
  price: number;
  gtin: string | null;
  manufacturer: string;
  active: boolean;
  shopActive: boolean;
  /** Physical quantity per warehouse ID; missing warehouses hold nothing. */
  stock: Record<string, number>;
  /** Open quantity of uncancelled sales orders. */
  reserved: number;
  /** Time of the last stock change; strictly increasing per item. */
  modified: string;
}

export interface AssignmentRecord {
  id: string;
  itemId: string;
  supplierId: string;
  netPrice: number;
  vatRate: number;
  isDefault: boolean;
}

export interface SupplierRecord {
  id: string;
  companyName: string;
  supplierNumber: string;
  active: boolean;
  email: string;
  city: string;
  countryIso: string;
  /** How the supplier answers purchase orders placed from now on. */
  profile: SupplierProfile;
}

interface OrderLineRecord {
  id: string;
  itemId: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  shipped: number;
  /** Gross unit price. */
  price: number;
}

/** A customer account, created by the order integration for a new email address. */
export interface CustomerRecord {
  id: string;
  number: string;
  firstName: string;
  lastName: string;
  company: string | null;
  email: string;
  phone: string | null;
  street: string;
  city: string;
  postalCode: string;
  countryIso: string;
  created: string;
  modified: string;
}

export interface OrderRecord {
  id: string;
  number: string;
  externalNumber: string | null;
  /** The customer who placed the order; absent on orders stored before customers existed. */
  customerId?: string | null;
  cancelled: boolean;
  paid: boolean;
  shippingMethodId: string;
  currency: string;
  total: number;
  date: string;
  /** Warehouse that fulfills the order; set by the order input or its latest shipment. */
  warehouse: string | null;
  /** Shipping date of the first delivery note. */
  shippedAt: string | null;
  lines: OrderLineRecord[];
}

export interface NoteRecord {
  id: string;
  orderId: string;
  warehouse: string;
  date: string;
  packages: {
    id: string;
    shippingDate: string;
    trackingNumber: string;
    trackingUrl: string;
  }[];
  lines: { id: string; orderLineId: string; quantity: number }[];
}

export interface PurchaseOrderLine {
  lineItemId: string;
  lineItemType: 1;
  itemId: string;
  itemNumber: string;
  name: string;
  quantity: number;
  deliveredQuantity: number;
  openQuantity: number;
  netPurchasePriceAmount: number;
  vatRatePercentage: number;
  sortOrder: number;
  deliveryDate: string;
  confirmedQuantity: number | null;
  confirmedDeliveryDate: string | null;
  isLineItemConfirmed: boolean | null;
}

/** A purchase order in JTL field names. */
export interface PurchaseOrderRecord {
  purchaseOrderId: string;
  supplierId: string;
  orderNumber: string;
  externalOrderNumber: string | null;
  internalComment: string | null;
  /** 0 Open, 5 Released, 20 InProgress, 30 PartiallyDelivered, 50 Overdue, 500 Completed. */
  status: 0 | 5 | 20 | 30 | 50 | 500;
  isConfirmed: boolean;
  createdAt: string;
  requestedDeliveryDate: string;
  /** Warehouse that receives the goods. */
  warehouseId: string;
  lineItems: PurchaseOrderLine[];
}

/** A provider refusal with the HTTP status the API answers with; commands surface the message. */
export class JtlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JtlError';
  }
}

/** Throws a JTL refusal; `status` is the API answer for the same condition. */
export function refuse(message: string, status = 400): never {
  throw new JtlError(status, message);
}

const MAX_ID = 2147483647;

/** Normalizes a JTL record ID, which is a positive 32-bit integer given as a number or digits. */
export function recordId(value: unknown) {
  const text = typeof value === 'number' ? String(value) : value;

  return typeof text === 'string' &&
    /^[1-9]\d{0,9}$/.test(text) &&
    Number(text) <= MAX_ID
    ? text
    : undefined;
}

/** Serializes a configured warehouse or shipping-method ID as a number when it is numeric. */
export const configId = (id: string) => (recordId(id) ? Number(id) : id);

/** True for a non-negative whole quantity that fits JTL's integer columns. */
export const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_ID;

/** Formats simulation milliseconds as an ISO timestamp. */
export const iso = (time: number) => new Date(time).toISOString();

/** Rounds a currency amount to cents. */
export const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * Allocates the next free numeric ID from a named counter, skipping IDs taken by fixtures that
 * chose their own.
 */
export async function allocate(context: JtlContext, kind: string) {
  for (;;) {
    const id = String(await context.store.sequence(kind));
    if (!(await context.store.get(kind, id))) return id;
  }
}

/** Allocates a numeric ID that is unique within a counter but names no stored record. */
export async function next(context: JtlContext, counter: string) {
  return String(await context.store.sequence(counter));
}

/** Resolves a configured warehouse, defaulting to the first one. */
export function warehouseOf(context: JtlContext, id?: string) {
  const warehouse = id ?? context.config.warehouses[0]?.id;
  if (!warehouse || !context.config.warehouses.some((w) => w.id === warehouse))
    refuse('Warehouse not found', 404);

  return warehouse;
}
