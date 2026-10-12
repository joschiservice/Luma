/** A return reason with its English name and, optionally, its German name. */
export interface JtlReturnReason {
  id: string;
  name: string;
  germanName?: string | undefined;
}

/**
 * One simulated JTL-Wawi ERP. Use numeric IDs, as JTL does; Luma reads them as external IDs.
 * The first warehouse receives purchase-order goods by default.
 */
export interface JtlConfig {
  warehouses: { id: string; name: string }[];
  shippingMethods: { id: string; name: string }[];
  /** Reasons a return line may record; `defaultReturnReasons` when omitted. */
  returnReasons?: JtlReturnReason[] | undefined;
}

/** Return reasons of a fresh JTL-Wawi installation. */
export const defaultReturnReasons: JtlReturnReason[] = [
  { id: '1', name: 'Defective', germanName: 'Defekt' },
  { id: '2', name: 'Wrong item', germanName: 'Falscher Artikel' },
  { id: '3', name: 'No longer wanted', germanName: 'Nicht mehr gewünscht' },
];

/** How a simulated supplier answers new purchase orders. */
export type SupplierProfile =
  'full' | 'partial' | 'delayed' | 'silent' | 'short';

export const supplierProfiles = [
  'full',
  'partial',
  'delayed',
  'silent',
  'short',
] as const satisfies readonly SupplierProfile[];

export interface JtlSeedItem {
  /** Numeric item ID. */
  id: string;
  sku: string;
  name: string;
  /** Gross sales price as a decimal string. */
  price: string;
  gtin: string | null;
  manufacturer: string;
  active: boolean;
  shopActive: boolean;
  /** Physical stock per warehouse ID. */
  stock: Record<string, number>;
  suppliers: { supplierId: string; netPrice: number; isDefault: boolean }[];
}

export interface JtlSeedSupplier {
  id: string;
  companyName: string;
  supplierNumber: string;
  city: string;
  countryIso: string;
  email: string;
  profile: SupplierProfile;
}

/** A shop customer as the order integration transfers it. */
export interface JtlCustomerInput {
  email: string;
  firstName: string;
  lastName: string;
  company?: string | undefined;
  phone?: string | undefined;
  street: string;
  city: string;
  postalCode: string;
  countryIso: string;
}

/**
 * Merchant, integration, warehouse and supplier actions. `id` values are numeric JTL record
 * IDs; sales orders, items and purchase orders use separate numbering.
 */
export type JtlCommand =
  | { kind: 'seed-catalog'; items: JtlSeedItem[]; suppliers: JtlSeedSupplier[] }
  | {
      kind: 'order';
      /** Explicit numeric ID for fixtures; allocated when omitted. */
      id?: string | undefined;
      /** Shop order number set by the order integration. */
      externalNumber?: string | undefined;
      /**
       * The shop customer; the integration reuses the JTL customer with the same email address
       * or creates one. Orders without a customer have none.
       */
      customer?: JtlCustomerInput | undefined;
      lines: {
        itemId: string;
        quantity: number;
        /** Gross unit price. */
        price: number;
      }[];
      /** Sales tax in percent included in the line prices; German VAT when omitted. */
      taxRate?: number | undefined;
      shippingMethodId: string;
      currency: string;
      paid: boolean;
      /** Warehouse planned to fulfill the order; a shipment records the warehouse it used. */
      warehouse?: string | undefined;
    }
  | { kind: 'paid'; id: string }
  | { kind: 'cancel'; id: string }
  /** Deletes a customer; their sales orders keep the customer ID. */
  | { kind: 'delete-customer'; id: string }
  | {
      kind: 'ship';
      id: string;
      warehouse: string;
      /** Line quantities to ship; every open unit when omitted. */
      lines?: { lineId: string; quantity: number }[] | undefined;
      trackingNumber: string;
      trackingUrl: string;
      /**
       * Records the delivery note while the parcel is still being packed: its package has no
       * shipping date yet, so the order is in fulfilment but not shipped.
       */
      packing?: boolean | undefined;
    }
  /** Sets physical stock of an item in one warehouse, as an inventory count does. */
  | { kind: 'stock'; itemId: string; warehouse: string; quantity: number }
  | { kind: 'shipping-method'; id: string; shippingMethodId: string }
  | {
      kind: 'purchase-order';
      supplierId: string;
      deliveryDate: string;
      lines: { itemId: string; quantity: number }[];
    }
  | {
      kind: 'purchase-order-confirm';
      orderId: string;
      lines?:
        | { lineItemId: string; quantity: number; deliveryDate: string }[]
        | undefined;
    }
  | {
      kind: 'purchase-order-receive';
      orderId: string;
      warehouse?: string | undefined;
      lines: { lineItemId: string; quantity: number }[];
    }
  | { kind: 'supplier-profile'; supplierId: string; profile: SupplierProfile };

/** A supplier response to a new order, due after `delay` simulation milliseconds. */
export interface SupplierEvent {
  delay: number;
  command: Extract<
    JtlCommand,
    { kind: 'purchase-order-confirm' | 'purchase-order-receive' }
  >;
}

/** What a command created or changed, for the host's scheduling and journal. */
export interface JtlCommandResult {
  /**
   * The record the command created or changed: the sales order, the delivery note for `ship`,
   * the purchase order, the item for `stock`, the supplier, the deleted customer, or `catalog`
   * for `seed-catalog`.
   */
  id: string;
  /**
   * Lines with numeric IDs: those created by `order` and `purchase-order`, or the sales-order
   * lines and quantities a `ship` booked.
   */
  lines?: { id: string; itemId: string; quantity: number }[] | undefined;
  /**
   * Supplier answers to schedule after a merchant `purchase-order`. Orders created through the
   * API carry theirs in the `purchase-orders/create` event instead.
   */
  supplierEvents?: SupplierEvent[] | undefined;
}
