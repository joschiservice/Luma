import type { LatencyProfile } from '@luma/simulator-core';

/** A product family with its own prices, variant dimensions and return behavior. */
export interface CategoryProfile {
  code: string;
  name: string;
  /** Share of products in this category. */
  share: number;
  priceRange: [number, number];
  /** Share of delivered order lines that come back. */
  returnRate: number;
  sizes: string[];
  colors: string[];
}

export interface ShopProfile {
  /** Simulator instance name, also used for the Luma connection. */
  instance: string;
  name: string;
  domain: string;
  country: string;
  currency: string;
  /** Share of all orders placed in this shop. */
  orderShare: number;
  /** Share of the catalog listed in this shop. */
  catalogShare: number;
  /** Shop prices relative to catalog prices. */
  priceFactor: number;
  /** Warehouse that fulfills this shop's orders, and the shop location that mirrors it. */
  warehouse: string;
  /** IANA time zone for the shop's daily demand curve. */
  timeZone: string;
}

export interface WarehouseProfile {
  id: string;
  name: string;
  city: string;
  /** Orders picked and packed per hour while staffed. */
  picksPerHour: number;
  /** Staffed hours in local time, start inclusive and end exclusive. */
  shift: [number, number];
  /** Share of each SKU's starting stock held here. */
  stockShare: number;
}

export interface CarrierProfile {
  name: string;
  share: number;
  transitDays: LatencyProfile;
  trackingPrefix: string;
  trackingUrl: string;
}

export interface Promotion {
  label: string;
  /** Hours after the run starts. */
  startsAfterHours: number;
  durationHours: number;
  multiplier: number;
  everyDays?: number | undefined;
}

/** Explicit products for deterministic fixtures; generated catalogs leave this empty. */
export interface FixedProduct {
  id: string;
  title: string;
  vendor: string;
  category: string;
  variants: {
    id: string;
    sku: string;
    title: string;
    price: number;
    barcode: string | null;
    stock: Record<string, number>;
    /** Listed only in these shop instances; all shops when omitted. */
    shops?: string[] | undefined;
    published?: boolean | undefined;
  }[];
}

/**
 * Describes a merchant's catalog, sales channels, warehouses, demand and partners. The
 * simulator generates the same world for the same profile and seed.
 */
export interface MerchantProfile {
  name: string;
  label: string;
  description: string;
  catalog: {
    products: number;
    variantsPerProduct: [number, number];
    categories: CategoryProfile[];
    /** Higher values concentrate demand on fewer SKUs. */
    popularityExponent: number;
    /** Starting stock in days of expected demand. */
    daysOfCover: [number, number];
    missingBarcodeRate: number;
    fixed?: FixedProduct[] | undefined;
  };
  shops: ShopProfile[];
  warehouses: WarehouseProfile[];
  demand: {
    /** Merchant orders arrive on their own; manual runs only change through commands. */
    autonomous: boolean;
    ordersPerDay: number;
    /** Relative demand per local hour. */
    hourly: number[];
    /** Relative demand per weekday, Sunday first. */
    weekly: number[];
    promotions: Promotion[];
  };
  basket: {
    /** Relative frequency of 1, 2, 3 … lines. */
    lineWeights: number[];
    /** Relative frequency of 1, 2, 3 … units per line. */
    quantityWeights: number[];
    expressShare: number;
  };
  customers: { returningShare: number };
  payments: { pendingRate: number; failedRate: number; fraudCheckRate: number };
  cancellations: { rate: number };
  carriers: CarrierProfile[];
  returns: {
    requestDelayDays: LatencyProfile;
    approveRate: number;
    receiveDelayDays: LatencyProfile;
    refundPendingRate: number;
  };
  suppliers: {
    count: number;
    /** Relative frequency of supplier behaviors for merchant purchase orders. */
    profileMix: Record<
      'full' | 'partial' | 'delayed' | 'short' | 'silent',
      number
    >;
    /** The merchant reorders in the ERP when stock falls below this many days of demand. */
    reorderBelowDays: number;
    reorderCoverDays: number;
    merchantReorders: boolean;
  };
  integration: {
    /** Delay before the integration imports a shop order into the ERP. */
    orderLag: LatencyProfile;
    /** Delay before a shipment booked in the ERP reaches the shop. */
    shipmentLag: LatencyProfile;
    /** Interval of the ERP-to-shop stock push. */
    stockSyncEveryMs: number;
  };
  /** Days of order history created before the run starts. */
  historyDays: number;
}

const hourly = [
  0.25, 0.15, 0.1, 0.08, 0.08, 0.12, 0.3, 0.55, 0.8, 0.95, 1.05, 1.1, 1.15, 1.1,
  1.05, 1.0, 1.0, 1.05, 1.2, 1.4, 1.5, 1.35, 0.95, 0.5,
];
const weekly = [1.2, 0.95, 0.9, 0.9, 0.95, 1.0, 1.1];

const fashionCategories: CategoryProfile[] = [
  {
    code: 'APP',
    name: 'Apparel',
    share: 0.45,
    priceRange: [19, 129],
    returnRate: 0.28,
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    colors: ['Black', 'Navy', 'Sand', 'Olive', 'White', 'Rust'],
  },
  {
    code: 'SHO',
    name: 'Shoes',
    share: 0.15,
    priceRange: [59, 189],
    returnRate: 0.22,
    sizes: ['38', '39', '40', '41', '42', '43', '44', '45'],
    colors: ['Black', 'Brown', 'White'],
  },
  {
    code: 'ACC',
    name: 'Accessories',
    share: 0.2,
    priceRange: [9, 79],
    returnRate: 0.08,
    sizes: [],
    colors: ['Black', 'Brown', 'Natural', 'Grey'],
  },
  {
    code: 'HOM',
    name: 'Home',
    share: 0.2,
    priceRange: [12, 249],
    returnRate: 0.05,
    sizes: [],
    colors: ['Natural', 'Charcoal', 'Stone'],
  },
];

const carriers: CarrierProfile[] = [
  {
    name: 'DHL',
    share: 0.6,
    transitDays: { medianMs: 1.6, p99Ms: 5 },
    trackingPrefix: '00340434',
    trackingUrl: 'https://tracking.example.test/dhl/',
  },
  {
    name: 'DPD',
    share: 0.25,
    transitDays: { medianMs: 1.8, p99Ms: 6 },
    trackingPrefix: '01505',
    trackingUrl: 'https://tracking.example.test/dpd/',
  },
  {
    name: 'Post CH',
    share: 0.15,
    transitDays: { medianMs: 2.5, p99Ms: 8 },
    trackingPrefix: '99.00',
    trackingUrl: 'https://tracking.example.test/post-ch/',
  },
];

const supplierMix = {
  full: 0.7,
  partial: 0.12,
  delayed: 0.1,
  short: 0.05,
  silent: 0.03,
};

const sharedCatalog = {
  popularityExponent: 1.07,
  daysOfCover: [10, 45] as [number, number],
  missingBarcodeRate: 0.02,
};

const shared = {
  basket: {
    lineWeights: [52, 26, 12, 6, 3, 1],
    quantityWeights: [82, 13, 4, 1],
    expressShare: 0.12,
  },
  customers: { returningShare: 0.35 },
  payments: { pendingRate: 0.03, failedRate: 0.01, fraudCheckRate: 0.004 },
  cancellations: { rate: 0.015 },
  carriers,
  returns: {
    requestDelayDays: { medianMs: 5, p99Ms: 20 },
    approveRate: 0.94,
    receiveDelayDays: { medianMs: 4, p99Ms: 12 },
    refundPendingRate: 0.05,
  },
  integration: {
    orderLag: { medianMs: 90_000, p99Ms: 900_000 },
    shipmentLag: { medianMs: 120_000, p99Ms: 1_800_000 },
    stockSyncEveryMs: 300_000,
  },
};

const dach: ShopProfile[] = [
  {
    instance: 'shopify-de',
    name: 'Luma Goods DE',
    domain: 'luma-goods-de.myshopify.com',
    country: 'DE',
    currency: 'EUR',
    orderShare: 0.62,
    catalogShare: 1,
    priceFactor: 1,
    warehouse: '1',
    timeZone: 'Europe/Berlin',
  },
  {
    instance: 'shopify-at',
    name: 'Luma Goods AT',
    domain: 'luma-goods-at.myshopify.com',
    country: 'AT',
    currency: 'EUR',
    orderShare: 0.2,
    catalogShare: 0.6,
    priceFactor: 1.03,
    warehouse: '2',
    timeZone: 'Europe/Vienna',
  },
  {
    instance: 'shopify-ch',
    name: 'Luma Goods CH',
    domain: 'luma-goods-ch.myshopify.com',
    country: 'CH',
    currency: 'CHF',
    orderShare: 0.18,
    catalogShare: 0.4,
    priceFactor: 1.08,
    warehouse: '3',
    timeZone: 'Europe/Zurich',
  },
];

const warehouses: WarehouseProfile[] = [
  {
    id: '1',
    name: 'Hamburg Hub',
    city: 'Hamburg',
    picksPerHour: 420,
    shift: [6, 22],
    stockShare: 0.6,
  },
  {
    id: '2',
    name: 'Linz Fulfillment',
    city: 'Linz',
    picksPerHour: 140,
    shift: [7, 19],
    stockShare: 0.25,
  },
  {
    id: '3',
    name: 'Basel Partner Warehouse',
    city: 'Basel',
    picksPerHour: 90,
    shift: [8, 18],
    stockShare: 0.15,
  },
];

const tote = (
  id: string,
  sku: string,
  title: string,
  stock: number,
  published = true,
): FixedProduct => ({
  id,
  title,
  vendor: 'Luma Goods',
  category: 'ACC',
  variants: [
    {
      id,
      sku,
      title: 'Default Title',
      price: 24,
      barcode: id === '1' ? '4006381333931' : null,
      stock: { '1': stock },
      published,
    },
  ],
});

/**
 * Merchant presets. `large` is the default: a DACH fashion and home brand with three shops on
 * one ERP. `test` is a small fixed world for deterministic platform tests.
 */
export const merchantProfiles = {
  test: {
    name: 'test',
    label: 'Test fixture',
    description:
      'Two fixed products, one shop and one warehouse. Orders, shipments and stock only change through commands.',
    catalog: {
      ...sharedCatalog,
      products: 0,
      variantsPerProduct: [1, 1],
      categories: fashionCategories,
      missingBarcodeRate: 0,
      fixed: [
        tote('1', 'LUMA-001', 'Canvas tote', 100),
        tote('2', 'LUMA-SCENARIO-001', 'Canvas tote · scenario', 100, false),
      ],
    },
    shops: [
      {
        ...dach[0]!,
        instance: 'shopify',
        name: 'Luma synthetic pilot',
        domain: 'luma-synthetic-pilot.myshopify.com',
        orderShare: 1,
      },
    ],
    // Fixture orders stay open until a test ships them explicitly.
    warehouses: [
      {
        ...warehouses[0]!,
        name: 'Main warehouse',
        stockShare: 1,
        picksPerHour: 0,
      },
    ],
    demand: {
      autonomous: false,
      ordersPerDay: 0,
      hourly,
      weekly,
      promotions: [],
    },
    ...shared,
    basket: { ...shared.basket, lineWeights: [1], quantityWeights: [1, 1, 1] },
    payments: { pendingRate: 0, failedRate: 0, fraudCheckRate: 0 },
    cancellations: { rate: 0 },
    suppliers: {
      count: 2,
      profileMix: { full: 1, partial: 0, delayed: 0, short: 0, silent: 0 },
      reorderBelowDays: 0,
      reorderCoverDays: 0,
      merchantReorders: false,
    },
    integration: {
      orderLag: { medianMs: 5_000, p99Ms: 5_000 },
      shipmentLag: { medianMs: 5_000, p99Ms: 5_000 },
      stockSyncEveryMs: 0,
    },
    historyDays: 0,
  },
  small: {
    name: 'small',
    label: 'Small shop',
    description: 'One shop and warehouse, about 600 SKUs and 200 orders a day.',
    catalog: {
      ...sharedCatalog,
      products: 150,
      variantsPerProduct: [1, 6],
      categories: fashionCategories,
    },
    shops: [{ ...dach[0]!, instance: 'shopify', orderShare: 1 }],
    warehouses: [{ ...warehouses[0]!, picksPerHour: 40, stockShare: 1 }],
    demand: {
      autonomous: true,
      ordersPerDay: 200,
      hourly,
      weekly,
      promotions: [],
    },
    ...shared,
    suppliers: {
      count: 6,
      profileMix: supplierMix,
      reorderBelowDays: 7,
      reorderCoverDays: 30,
      merchantReorders: true,
    },
    historyDays: 3,
  },
  'mid-market': {
    name: 'mid-market',
    label: 'Mid-market',
    description:
      'Two shops on one ERP with two warehouses, about 6,000 SKUs and 1,000 orders a day.',
    catalog: {
      ...sharedCatalog,
      products: 1_500,
      variantsPerProduct: [1, 8],
      categories: fashionCategories,
    },
    shops: [
      { ...dach[0]!, orderShare: 0.75 },
      { ...dach[1]!, orderShare: 0.25, warehouse: '1' },
    ],
    warehouses: [
      { ...warehouses[0]!, picksPerHour: 140, stockShare: 0.8 },
      { ...warehouses[1]!, picksPerHour: 40, stockShare: 0.2 },
    ],
    demand: {
      autonomous: true,
      ordersPerDay: 1_000,
      hourly,
      weekly,
      promotions: [],
    },
    ...shared,
    suppliers: {
      count: 18,
      profileMix: supplierMix,
      reorderBelowDays: 7,
      reorderCoverDays: 30,
      merchantReorders: true,
    },
    historyDays: 2,
  },
  large: {
    name: 'large',
    label: 'Large merchant',
    description:
      'Three DACH shops on one ERP with three warehouses, about 40,000 SKUs and 5,000 orders a day with tenfold peaks.',
    catalog: {
      ...sharedCatalog,
      products: 8_000,
      variantsPerProduct: [1, 9],
      categories: fashionCategories,
    },
    shops: dach,
    warehouses,
    demand: {
      autonomous: true,
      ordersPerDay: 5_000,
      hourly,
      weekly,
      promotions: [
        {
          label: 'Flash sale',
          startsAfterHours: 30,
          durationHours: 3,
          multiplier: 10,
          everyDays: 7,
        },
      ],
    },
    ...shared,
    suppliers: {
      count: 40,
      profileMix: supplierMix,
      reorderBelowDays: 7,
      reorderCoverDays: 30,
      merchantReorders: true,
    },
    historyDays: 2,
  },
} satisfies Record<string, MerchantProfile>;

export type MerchantProfileName = keyof typeof merchantProfiles;

/** Returns a copy of a preset that callers may change. */
export function merchantProfile(name: MerchantProfileName): MerchantProfile {
  return structuredClone(merchantProfiles[name]);
}
