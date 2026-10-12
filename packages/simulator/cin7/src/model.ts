import type { ProviderContext } from '@luma/simulator-core';

/**
 * One simulated Cin7 Core account. Warehouses are Cin7 locations; `accountId` is the account
 * the API accepts. Record IDs, including warehouse IDs, are numeric.
 */
export interface Cin7Config {
  accountId: string;
  company: string;
  /** The account's base currency; customer and supplier records trade in it. */
  baseCurrency: string;
  /** Base-currency units per unit of each foreign customer currency. */
  currencyRates?: Record<string, number> | undefined;
  warehouses: { id: string; name: string }[];
  shippingMethods: { id: string; name: string }[];
}

export type Cin7Context = ProviderContext<Cin7Config>;

/**
 * The ERP model a host runs behind the Cin7 API: where it stores each record kind and how it
 * applies merchant, warehouse and supplier commands. The account serves the stored records;
 * it never changes them itself.
 */
export interface ErpModel<Command, Result> {
  kinds: {
    item: string;
    customer: string;
    supplier: string;
    /** Sales orders; their delivery notes use the order ID as parent. */
    order: string;
    note: string;
    purchaseOrder: string;
  };
  command(context: Cin7Context, command: Command): Promise<Result>;
}

/** A catalog item with its physical stock per warehouse and account-wide reservation. */
export interface ErpItem {
  id: string;
  sku: string;
  name: string;
  price: number;
  gtin: string | null;
  manufacturer: string;
  active: boolean;
  stock: Record<string, number>;
  reserved: number;
  modified: string;
}

export interface ErpCustomer {
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
  modified: string;
}

export interface ErpSupplier {
  id: string;
  companyName: string;
  active: boolean;
  email: string;
  city: string;
  countryIso: string;
}

export interface ErpOrder {
  id: string;
  externalNumber: string | null;
  customerId?: string | null | undefined;
  cancelled: boolean;
  paid: boolean;
  shippingMethodId: string;
  currency: string;
  /** Sales tax in percent included in the line prices; none when absent. */
  taxRate?: number | undefined;
  total: number;
  date: string;
  lines: {
    id: string;
    itemId: string;
    sku: string;
    name: string;
    quantity: number;
    shipped: number;
    price: number;
  }[];
}

export interface ErpNote {
  id: string;
  orderId: string;
  warehouse: string;
  packages: {
    id: string;
    shippingDate: string;
    trackingNumber: string;
    trackingUrl: string;
  }[];
  lines: { orderLineId: string; quantity: number }[];
}

export interface ErpPurchaseOrder {
  purchaseOrderId: string;
  supplierId: string;
  orderNumber: string;
  /** 0 Open, 5 Released, 20 InProgress, 30 PartiallyDelivered, 50 Overdue, 500 Completed. */
  status: number;
  createdAt: string;
  requestedDeliveryDate: string;
  warehouseId: string;
  lineItems: {
    itemId: string;
    itemNumber: string;
    name: string;
    quantity: number;
    deliveredQuantity: number;
    netPurchasePriceAmount: number;
  }[];
}

/** The account ID of simulated Cin7 accounts; local pilots connect with it. */
export const simulatedAccountId = 'c1700000-0000-4000-8000-000000000001';

// Each record kind has its own GUID prefix, so an ID names its kind and numeric record.
const prefixes = {
  sale: 'c1700001',
  product: 'c1700002',
  location: 'c1700003',
  customer: 'c1700004',
  supplier: 'c1700005',
  purchase: 'c1700006',
  fulfilment: 'c1700007',
  shipment: 'c1700008',
} as const;

export type GuidKind = keyof typeof prefixes;

/** The stable Cin7 GUID of a numeric ERP record. */
export const guid = (kind: GuidKind, id: string) =>
  `${prefixes[kind]}-0000-4000-8000-${id.padStart(12, '0')}`;

/** The numeric ERP record a Cin7 GUID names; undefined for another kind or a foreign ID. */
export function recordOf(kind: GuidKind, value: string | null | undefined) {
  const match = new RegExp(
    `^${prefixes[kind]}-0000-4000-8000-(\\d{12})$`,
    'i',
  ).exec(value ?? '');

  return match ? String(Number(match[1])) : undefined;
}

/** How much of an order has shipped: none, some or all. */
export function shipped(order: ErpOrder) {
  const units = order.lines.reduce((sum, line) => sum + line.shipped, 0);
  if (!units) return 'none';

  return order.lines.every((line) => line.shipped >= line.quantity)
    ? 'all'
    : 'some';
}

/**
 * Spreads an item's reserved units over its locations in configured order, up to each
 * location's on-hand quantity; reservations beyond all stock stay at the first location. The
 * stock report and the simulated stock sync both use it, so a shop that mirrors one location
 * sees what Cin7 reports there.
 */
export function allocation(
  stock: Record<string, number>,
  reserved: number,
  locations: readonly string[],
) {
  const allocated: Record<string, number> = {};
  let open = reserved;
  for (const location of locations) {
    const take = Math.max(0, Math.min(open, stock[location] ?? 0));
    allocated[location] = take;
    open -= take;
  }
  const first = locations[0];
  if (first !== undefined && open > 0) allocated[first]! += open;

  return allocated;
}

/** Available units at one location under `allocation`; negative when orders oversell. */
export function availableAt(
  stock: Record<string, number>,
  reserved: number,
  locations: readonly string[],
  location: string,
) {
  return (
    (stock[location] ?? 0) -
    (allocation(stock, reserved, locations)[location] ?? 0)
  );
}

/** Cin7 dates carry no zone designator; the API reports UTC. */
export const cin7Time = (time: number | string) =>
  new Date(time).toISOString().slice(0, 23);
