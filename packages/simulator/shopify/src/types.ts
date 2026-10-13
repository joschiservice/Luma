/** One simulated Shopify store. */
export interface ShopifyConfig {
  /** `*.myshopify.com` domain, also used in webhook headers. */
  shop: string;
  name: string;
  currency: string;
  /** Standard tax rate on every line as a fraction, such as 0.19; omit for a shop that charges none. */
  taxRate?: number;
  /** Whether prices include tax, as in most European shops; defaults to false. */
  taxesIncluded?: boolean;
  /** Prefix of order names, such as `DE` for `#DE1001`. */
  orderPrefix: string;
  /** Shop locations; numeric IDs become `gid://shopify/Location/<id>`. */
  locations: { id: string; name: string }[];
  /** Access scopes the installation reports, such as `read_orders`. */
  scopes: string[];
}

/** Hold reasons a merchant or fraud check can apply. */
export const shopifyHoldReasons = [
  'AWAITING_PAYMENT',
  'HIGH_RISK_OF_FRAUD',
  'INCORRECT_ADDRESS',
  'INVENTORY_OUT_OF_STOCK',
  'UNKNOWN_DELIVERY_DATE',
  'OTHER',
] as const;

export type ShopifyHoldReason = (typeof shopifyHoldReasons)[number];

export interface ShopifySeedProduct {
  /** Numeric product ID. */
  id: string;
  title: string;
  vendor: string;
  productType: string;
  published: boolean;
  variants: {
    /** Numeric ID shared by the variant and its inventory item. */
    id: string;
    sku: string;
    title: string;
    price: string;
    barcode: string | null;
    /** On-hand quantity per numeric location ID. */
    stock: Record<string, number>;
  }[];
}

export interface ShopifyCustomerInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: { address1: string; city: string; zip: string; countryCode: string };
}

interface ShopifyOrderLineInput {
  /** Numeric variant ID. */
  variant: string;
  quantity: number;
  /** Unit price as a decimal string in the shop currency. */
  price: string;
}

/** Fulfillment display states a carrier reports. */
export type ShipmentStatus =
  'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'DELAYED' | 'FAILURE';

/**
 * Merchant, customer and integration actions. Numeric IDs are provider record numbers within
 * this shop; `order` refers to the numeric order ID.
 */
export type ShopifyCommand =
  | { kind: 'inventory-transfer'; transfer: ShopifyInventoryTransfer }
  | { kind: 'seed-catalog'; products: ShopifySeedProduct[] }
  | { kind: 'customer'; customer: ShopifyCustomerInput }
  | {
      kind: 'order';
      /** Explicit numeric ID for fixtures; allocated when omitted. */
      id?: string | undefined;
      customer?: string | null | undefined;
      lines: ShopifyOrderLineInput[];
      location: string;
      shipping: 'standard' | 'express';
      financialStatus: 'PAID' | 'PENDING';
      holds?: ShopifyHoldReason[] | undefined;
      /**
       * Scheduled fulfillment time in simulation milliseconds, as for preorders. A later
       * time leaves the fulfillment order SCHEDULED until it is opened.
       */
      fulfillAt?: number | undefined;
      /**
       * Discounts across all lines. Line prices are the prices after discounts; the original
       * price is derived from each percentage, so the order total does not change.
       */
      discounts?:
        | { kind: 'code' | 'automatic'; label: string; percentage: number }[]
        | undefined;
      /** Shipping charge as a decimal string in the shop currency; free when omitted. */
      shippingPrice?: string | undefined;
      /** Merchant tags. */
      tags?: string[] | undefined;
      /** The customer's currency and its rate per shop currency unit. */
      presentment?: { currency: string; rate: number } | undefined;
    }
  | {
      kind: 'order-edit';
      order: string;
      /** New current quantities; zero removes the line, shipped units cannot be removed. */
      lines: { lineItem: string; quantity: number }[];
    }
  | { kind: 'paid'; order: string }
  | { kind: 'exchange-pay'; order: string }
  | {
      kind: 'cancel';
      order: string;
      reason: 'CUSTOMER' | 'DECLINED' | 'FRAUD' | 'INVENTORY' | 'OTHER';
    }
  | { kind: 'hold'; order: string; reason: ShopifyHoldReason }
  | { kind: 'release'; order: string }
  /** Sets on-hand stock at a location; available is on hand minus committed. */
  | { kind: 'stock'; variant: string; location: string; quantity: number }
  /** Sets available stock as a stock sync does, keeping committed units. */
  | { kind: 'available'; variant: string; location: string; quantity: number }
  | {
      kind: 'fulfill';
      order: string;
      /** Line quantities to ship; every remaining unit when omitted. */
      lines?: { lineItem: string; quantity: number }[] | undefined;
      carrier: string;
      trackingNumber: string;
      trackingUrl: string;
      estimatedDeliveryAt?: number | undefined;
    }
  | { kind: 'shipment-status'; fulfillment: string; status: ShipmentStatus }
  | {
      kind: 'return';
      order: string;
      lines: { lineItem: string; quantity: number }[];
      reason: string;
    }
  | {
      kind:
        | 'return-approve'
        | 'return-decline'
        | 'return-receive'
        | 'return-close'
        | 'refund-settle';
      order: string;
    }
  | {
      kind: 'refund';
      order: string;
      outcome: 'success' | 'pending' | 'failure';
    }
  | {
      kind: 'product-update';
      product: string;
      price?: string | undefined;
      status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | undefined;
      published?: boolean | undefined;
    };

/** What a command created or changed, for the host's scheduling and journal. */
export interface ShopifyCommandResult {
  /** Numeric ID of the record the command created or changed. */
  id: string;
  /** Order name, such as `#DE1001`, for orders. */
  name?: string | undefined;
  /** Shopify global ID of that record. */
  gid: string;
  /** Changed line items with their numeric IDs, for orders. */
  lines?: { id: string; variant: string; quantity: number }[] | undefined;
}

/** Immutable location facts captured by a merchant's transfer request. A deleted live location stays null. */
interface ShopifyTransferLocation {
  location: string | null;
  name: string;
  snapshottedAt: string;
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    countryCode: string | null;
    zip: string | null;
  };
}

/** Merchant-supplied transfer evidence; changing it does not implicitly change stock balances. */
export interface ShopifyInventoryTransfer {
  id: string;
  name: string;
  status:
    | 'DRAFT'
    | 'READY_TO_SHIP'
    | 'IN_PROGRESS'
    | 'TRANSFERRED'
    | 'CANCELED'
    | 'OTHER';
  dateCreated: string | null;
  origin: ShopifyTransferLocation | null;
  destination: ShopifyTransferLocation | null;
  totalQuantity: number;
  receivedQuantity: number;
  lines: {
    id: string;
    inventoryItem: string | null;
    title: string | null;
    totalQuantity: number;
    pickedForShipmentQuantity: number;
    shippableQuantity: number;
    shippedQuantity: number;
  }[];
  shipments: ShopifyInventoryShipment[];
}

/** Receiving evidence includes independently reported accepted, rejected and unreceived units. */
export interface ShopifyInventoryShipment {
  id: string;
  name: string;
  status: 'DRAFT' | 'IN_TRANSIT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'OTHER';
  dateCreated: string | null;
  dateShipped: string | null;
  dateReceived: string | null;
  lineItemTotalQuantity: number;
  totalAcceptedQuantity: number;
  totalRejectedQuantity: number;
  totalReceivedQuantity: number;
  tracking: {
    arrivesAt: string | null;
    company: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
  } | null;
  /** Null represents an unavailable collection, rather than an empty shipment. */
  lines:
    | {
        id: string;
        inventoryItem: string | null;
        quantity: number;
        acceptedQuantity: number;
        rejectedQuantity: number;
        unreceivedQuantity: number;
      }[]
    | null;
}
