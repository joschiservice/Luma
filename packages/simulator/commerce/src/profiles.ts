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
  /** Words that describe a product's material or ingredient in titles; general materials when omitted. */
  materials?: string[] | undefined;
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
  /**
   * Sales tax the shop charges on every line. Prices include it where `included`; otherwise
   * the checkout adds it, as US stores do.
   */
  tax: { rate: number; included: boolean };
}

interface WarehouseProfile {
  id: string;
  name: string;
  city: string;
  /** IANA time zone of the warehouse's shift. */
  timeZone: string;
  /** Orders picked and packed per hour while staffed. */
  picksPerHour: number;
  /** Staffed hours in local time, start inclusive and end exclusive. */
  shift: [number, number];
  /** Share of each SKU's starting stock held here. */
  stockShare: number;
}

interface CarrierProfile {
  name: string;
  /** Relative share among the carriers that serve a warehouse. */
  share: number;
  /** Warehouses this carrier collects from; all when omitted. */
  warehouses?: string[] | undefined;
  transitDays: LatencyProfile;
  trackingPrefix: string;
  trackingUrl: string;
}

interface Promotion {
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

/** A supplier company as the merchant's ERP records it. */
export interface SupplierDirectoryEntry {
  name: string;
  city: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
}

/**
 * Business-to-business sales that the merchant books directly in the ERP, such as retailer
 * reorders. They never pass through a shop, so no shop order matches them.
 */
interface WholesaleProfile {
  /** Orders per weekday; accounts order during the warehouse's business hours. */
  ordersPerDay: number;
  /** Retail accounts that order; each order comes from one of them. */
  accounts: number;
  /** Country of the accounts. */
  country: string;
  /** Warehouse that fulfills wholesale orders. */
  warehouse: string;
  linesPerOrder: [number, number];
  unitsPerLine: [number, number];
  /** Wholesale prices relative to catalog prices. */
  priceFactor: number;
  /** Sales tax added to wholesale prices. */
  taxRate: number;
  /** Days until an account pays its invoice. */
  paymentDays: LatencyProfile;
}

/**
 * Describes a merchant's business: its company and region, catalog, sales channels,
 * warehouses, demand and partners, and the ERP such a merchant typically runs. The simulator
 * generates the same world for the same profile and seed.
 */
export interface MerchantProfile {
  name: string;
  label: string;
  description: string;
  /** The merchant's usual ERP; a run may choose another to test compatibility. */
  erp: 'jtl' | 'cin7';
  company: {
    /** Legal name used in purchase orders and the ERP account. */
    name: string;
    city: string;
    /** Language of the merchant's own documents and mailbox labels. */
    language: 'de' | 'en';
    /** The shared operations mailbox; use a reserved `.example` domain. */
    mailbox: { address: string; name: string };
  };
  currency: {
    /** Currency the ERP books in and catalog prices use. */
    base: string;
    /** Base-currency units per unit of each other shop currency. */
    rates: Record<string, number>;
  };
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
  wholesale?: WholesaleProfile | undefined;
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
    /** Days between a merchant purchase order and its requested delivery. */
    leadTimeDays: number;
    /** Supplier companies in order; a default European list when omitted. */
    directory?: SupplierDirectoryEntry[] | undefined;
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

const lumaGoods = {
  erp: 'jtl' as const,
  company: {
    name: 'Luma Goods GmbH',
    city: 'Hamburg',
    language: 'de' as const,
    mailbox: {
      address: 'einkauf@luma-goods.example',
      name: 'Luma Goods Einkauf',
    },
  },
  currency: { base: 'EUR', rates: { CHF: 1.07 } },
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
    tax: { rate: 0.19, included: true },
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
    tax: { rate: 0.2, included: true },
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
    tax: { rate: 0.081, included: true },
  },
];

const warehouses: WarehouseProfile[] = [
  {
    id: '1',
    name: 'Hamburg Hub',
    city: 'Hamburg',
    timeZone: 'Europe/Berlin',
    picksPerHour: 420,
    shift: [6, 22],
    stockShare: 0.6,
  },
  {
    id: '2',
    name: 'Linz Fulfillment',
    city: 'Linz',
    timeZone: 'Europe/Vienna',
    picksPerHour: 140,
    shift: [7, 19],
    stockShare: 0.25,
  },
  {
    id: '3',
    name: 'Basel Partner Warehouse',
    city: 'Basel',
    timeZone: 'Europe/Zurich',
    picksPerHour: 90,
    shift: [8, 18],
    stockShare: 0.15,
  },
];

const anzCategories: CategoryProfile[] = [
  {
    code: 'HOM',
    name: 'Home',
    share: 0.4,
    priceRange: [19, 349],
    returnRate: 0.04,
    sizes: [],
    colors: ['Natural', 'Sage', 'Terracotta', 'Charcoal'],
  },
  {
    code: 'APP',
    name: 'Apparel',
    share: 0.35,
    priceRange: [39, 189],
    returnRate: 0.18,
    sizes: ['XS', 'S', 'M', 'L', 'XL'],
    colors: ['Black', 'Sand', 'Ocean', 'White'],
  },
  {
    code: 'ACC',
    name: 'Accessories',
    share: 0.25,
    priceRange: [15, 99],
    returnRate: 0.06,
    sizes: [],
    colors: ['Natural', 'Black', 'Tan'],
  },
];

const anzCarriers: CarrierProfile[] = [
  {
    name: 'Australia Post',
    share: 0.6,
    warehouses: ['1'],
    transitDays: { medianMs: 2.5, p99Ms: 9 },
    trackingPrefix: '33LPK',
    trackingUrl: 'https://tracking.example.test/auspost/',
  },
  {
    name: 'StarTrack',
    share: 0.3,
    warehouses: ['1'],
    transitDays: { medianMs: 1.8, p99Ms: 6 },
    trackingPrefix: 'STK',
    trackingUrl: 'https://tracking.example.test/startrack/',
  },
  {
    name: 'Aramex',
    share: 0.1,
    warehouses: ['1'],
    transitDays: { medianMs: 2.2, p99Ms: 8 },
    trackingPrefix: '3000',
    trackingUrl: 'https://tracking.example.test/aramex-au/',
  },
  {
    name: 'NZ Post',
    share: 0.7,
    warehouses: ['2'],
    transitDays: { medianMs: 1.6, p99Ms: 5 },
    trackingPrefix: 'NZP',
    trackingUrl: 'https://tracking.example.test/nzpost/',
  },
  {
    name: 'NZ Couriers',
    share: 0.3,
    warehouses: ['2'],
    transitDays: { medianMs: 1.3, p99Ms: 4 },
    trackingPrefix: 'NZC',
    trackingUrl: 'https://tracking.example.test/nzcouriers/',
  },
];

// Most stock is made in Asia and shipped by sea, so lead times are long.
const anzSuppliers: SupplierDirectoryEntry[] = [
  { name: 'Ningbo Homeware Co., Ltd.', city: 'Ningbo', country: 'CN' },
  { name: 'Saigon Apparel JSC', city: 'Ho Chi Minh City', country: 'VN' },
  { name: 'Jaipur Block Print Pvt Ltd', city: 'Jaipur', country: 'IN' },
  { name: 'Bandung Ceramics PT', city: 'Bandung', country: 'ID' },
  { name: 'Shenzhen Brightline Textiles', city: 'Shenzhen', country: 'CN' },
  { name: 'Dhaka Knit Composite Ltd', city: 'Dhaka', country: 'BD' },
  { name: 'Melbourne Packaging Pty Ltd', city: 'Melbourne', country: 'AU' },
  { name: 'Canterbury Wool Co Ltd', city: 'Christchurch', country: 'NZ' },
];

const ukUsCategories: CategoryProfile[] = [
  {
    code: 'OUT',
    name: 'Outerwear',
    share: 0.35,
    priceRange: [69, 329],
    returnRate: 0.16,
    sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    colors: ['Black', 'Moss', 'Navy', 'Rust'],
  },
  {
    code: 'SHO',
    name: 'Footwear',
    share: 0.2,
    priceRange: [79, 199],
    returnRate: 0.2,
    sizes: ['6', '7', '8', '9', '10', '11', '12'],
    colors: ['Black', 'Brown'],
  },
  {
    code: 'CMP',
    name: 'Camp',
    share: 0.25,
    priceRange: [12, 449],
    returnRate: 0.05,
    sizes: [],
    colors: ['Olive', 'Orange', 'Grey'],
  },
  {
    code: 'ACC',
    name: 'Accessories',
    share: 0.2,
    priceRange: [9, 69],
    returnRate: 0.04,
    sizes: [],
    colors: ['Black', 'Moss', 'Navy'],
  },
];

const ukUsCarriers: CarrierProfile[] = [
  {
    name: 'Royal Mail',
    share: 0.65,
    warehouses: ['1'],
    transitDays: { medianMs: 1.8, p99Ms: 6 },
    trackingPrefix: 'RM',
    trackingUrl: 'https://tracking.example.test/royalmail/',
  },
  {
    name: 'DPD UK',
    share: 0.35,
    warehouses: ['1'],
    transitDays: { medianMs: 1.2, p99Ms: 4 },
    trackingPrefix: '15501',
    trackingUrl: 'https://tracking.example.test/dpd-uk/',
  },
  {
    name: 'UPS',
    share: 0.55,
    warehouses: ['2'],
    transitDays: { medianMs: 3, p99Ms: 8 },
    trackingPrefix: '1Z',
    trackingUrl: 'https://tracking.example.test/ups/',
  },
  {
    name: 'USPS',
    share: 0.45,
    warehouses: ['2'],
    transitDays: { medianMs: 3.5, p99Ms: 10 },
    trackingPrefix: '9400',
    trackingUrl: 'https://tracking.example.test/usps/',
  },
];

const ukUsSuppliers: SupplierDirectoryEntry[] = [
  { name: 'Hanoi Outdoor Garments Co.', city: 'Hanoi', country: 'VN' },
  { name: 'Felgueiras Footwear Lda', city: 'Felgueiras', country: 'PT' },
  { name: 'Xiamen Trailgear Co., Ltd.', city: 'Xiamen', country: 'CN' },
  { name: 'Pennine Textiles Ltd', city: 'Huddersfield', country: 'GB' },
  { name: 'Busan Technical Fabrics Co.', city: 'Busan', country: 'KR' },
  { name: 'Leicester Knitwear Ltd', city: 'Leicester', country: 'GB' },
];

const beautyCategories: CategoryProfile[] = [
  {
    code: 'SKN',
    name: 'Skincare',
    share: 0.45,
    priceRange: [12, 69],
    returnRate: 0.02,
    sizes: ['30 ml', '50 ml'],
    colors: ['Standard'],
    materials: [
      'Rose',
      'Calendula',
      'Hyaluron',
      'Aloe',
      'Oat',
      'Sea Buckthorn',
      'Chamomile',
      'Vitamin C',
    ],
  },
  {
    code: 'HAI',
    name: 'Haircare',
    share: 0.2,
    priceRange: [8, 29],
    returnRate: 0.02,
    sizes: ['200 ml', '500 ml'],
    colors: ['Standard'],
    materials: ['Birch', 'Nettle', 'Argan', 'Rosemary', 'Oat', 'Hops'],
  },
  {
    code: 'BOD',
    name: 'Body',
    share: 0.25,
    priceRange: [6, 34],
    returnRate: 0.015,
    sizes: [],
    colors: ['Lavender', 'Citrus', 'Unscented', 'Pine'],
    materials: ['Shea', 'Almond', 'Olive', 'Jojoba', 'Clay', 'Honey'],
  },
  {
    code: 'FRA',
    name: 'Fragrance',
    share: 0.1,
    priceRange: [29, 119],
    returnRate: 0.04,
    sizes: ['30 ml', '100 ml'],
    colors: ['Standard'],
    materials: ['Cedar', 'Bergamot', 'Vetiver', 'Fig', 'Neroli', 'Amber'],
  },
];

const beautySuppliers: SupplierDirectoryEntry[] = [
  {
    name: 'Sachsen Kosmetik Lohnfertigung GmbH',
    city: 'Dresden',
    country: 'DE',
  },
  { name: 'Allgäu Naturrohstoffe GmbH', city: 'Kempten', country: 'DE' },
  { name: 'Tiroler Kräuterhof GmbH', city: 'Innsbruck', country: 'AT' },
  { name: 'Grasse Essences SARL', city: 'Grasse', country: 'FR' },
  { name: 'Verpackungswerk Thüringen GmbH', city: 'Erfurt', country: 'DE' },
  { name: 'Emilia Flaconi Srl', city: 'Bologna', country: 'IT' },
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
 * JTL-Wawi. `test` is a small fixed world for deterministic platform tests. The regional
 * presets model merchants as they typically run: ANZ and UK/US brands on Cin7 Core, and a
 * DACH beauty brand on JTL-Wawi that also sells to retailers.
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
    ...lumaGoods,
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
      leadTimeDays: 7,
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
    ...lumaGoods,
    ...shared,
    suppliers: {
      count: 6,
      profileMix: supplierMix,
      reorderBelowDays: 7,
      reorderCoverDays: 30,
      merchantReorders: true,
      leadTimeDays: 7,
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
    ...lumaGoods,
    ...shared,
    suppliers: {
      count: 18,
      profileMix: supplierMix,
      reorderBelowDays: 7,
      reorderCoverDays: 30,
      merchantReorders: true,
      leadTimeDays: 7,
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
    ...lumaGoods,
    ...shared,
    suppliers: {
      count: 40,
      profileMix: supplierMix,
      reorderBelowDays: 7,
      reorderCoverDays: 30,
      merchantReorders: true,
      leadTimeDays: 7,
    },
    historyDays: 2,
  },
  'anz-lifestyle': {
    name: 'anz-lifestyle',
    label: 'ANZ lifestyle brand',
    description:
      'Australian home and apparel brand on Cin7 Core with AU and NZ shops, Sydney and Auckland warehouses, retailer wholesale orders and Asian suppliers. About 3,000 SKUs and 600 shop orders a day.',
    erp: 'cin7',
    company: {
      name: 'Harbour & Pine Pty Ltd',
      city: 'Sydney',
      language: 'en',
      mailbox: {
        address: 'purchasing@harbourandpine.example',
        name: 'Harbour & Pine Purchasing',
      },
    },
    currency: { base: 'AUD', rates: { NZD: 0.91 } },
    catalog: {
      ...sharedCatalog,
      products: 1_000,
      variantsPerProduct: [1, 5],
      categories: anzCategories,
    },
    shops: [
      {
        instance: 'shopify-au',
        name: 'Harbour & Pine',
        domain: 'harbour-and-pine.myshopify.com',
        country: 'AU',
        currency: 'AUD',
        orderShare: 0.78,
        catalogShare: 1,
        priceFactor: 1,
        warehouse: '1',
        timeZone: 'Australia/Sydney',
        tax: { rate: 0.1, included: true },
      },
      {
        instance: 'shopify-nz',
        name: 'Harbour & Pine NZ',
        domain: 'harbour-and-pine-nz.myshopify.com',
        country: 'NZ',
        currency: 'NZD',
        orderShare: 0.22,
        catalogShare: 0.7,
        priceFactor: 1.12,
        warehouse: '2',
        timeZone: 'Pacific/Auckland',
        tax: { rate: 0.15, included: true },
      },
    ],
    warehouses: [
      {
        id: '1',
        name: 'Sydney DC',
        city: 'Sydney',
        timeZone: 'Australia/Sydney',
        picksPerHour: 70,
        shift: [7, 17],
        stockShare: 0.8,
      },
      {
        id: '2',
        name: 'Auckland Warehouse',
        city: 'Auckland',
        timeZone: 'Pacific/Auckland',
        picksPerHour: 20,
        shift: [8, 16],
        stockShare: 0.2,
      },
    ],
    demand: {
      autonomous: true,
      ordersPerDay: 600,
      hourly,
      weekly,
      promotions: [
        {
          label: 'Click Frenzy',
          startsAfterHours: 36,
          durationHours: 6,
          multiplier: 4,
        },
      ],
    },
    wholesale: {
      ordersPerDay: 20,
      accounts: 120,
      country: 'AU',
      warehouse: '1',
      linesPerOrder: [3, 18],
      unitsPerLine: [4, 24],
      priceFactor: 0.5,
      taxRate: 0.1,
      paymentDays: { medianMs: 30, p99Ms: 75 },
    },
    ...shared,
    customers: { returningShare: 0.3 },
    carriers: anzCarriers,
    suppliers: {
      count: 8,
      profileMix: { ...supplierMix, delayed: 0.18, full: 0.62 },
      reorderBelowDays: 45,
      reorderCoverDays: 90,
      merchantReorders: true,
      leadTimeDays: 60,
      directory: anzSuppliers,
    },
    historyDays: 1,
  },
  'uk-us-dtc': {
    name: 'uk-us-dtc',
    label: 'UK/US outdoor brand',
    description:
      'British outdoor brand on Cin7 Core with a UK shop shipped from its own warehouse and a US shop shipped by a 3PL. About 4,500 SKUs and 900 orders a day.',
    erp: 'cin7',
    company: {
      name: 'Fernway Outdoor Ltd',
      city: 'Kendal',
      language: 'en',
      mailbox: {
        address: 'buying@fernway.example',
        name: 'Fernway Buying',
      },
    },
    currency: { base: 'GBP', rates: { USD: 0.79 } },
    catalog: {
      ...sharedCatalog,
      products: 1_100,
      variantsPerProduct: [1, 7],
      categories: ukUsCategories,
    },
    shops: [
      {
        instance: 'shopify-uk',
        name: 'Fernway',
        domain: 'fernway-outdoor.myshopify.com',
        country: 'GB',
        currency: 'GBP',
        orderShare: 0.6,
        catalogShare: 1,
        priceFactor: 1,
        warehouse: '1',
        timeZone: 'Europe/London',
        tax: { rate: 0.2, included: true },
      },
      {
        instance: 'shopify-us',
        name: 'Fernway US',
        domain: 'fernway-outdoor-us.myshopify.com',
        country: 'US',
        currency: 'USD',
        orderShare: 0.4,
        catalogShare: 0.75,
        priceFactor: 1.25,
        warehouse: '2',
        timeZone: 'America/New_York',
        // US prices exclude sales tax; one typical combined state and local rate stands in for all.
        tax: { rate: 0.0725, included: false },
      },
    ],
    warehouses: [
      {
        id: '1',
        name: 'Kendal Warehouse',
        city: 'Kendal',
        timeZone: 'Europe/London',
        picksPerHour: 80,
        shift: [7, 19],
        stockShare: 0.6,
      },
      {
        id: '2',
        name: 'Reno 3PL',
        city: 'Reno',
        timeZone: 'America/Los_Angeles',
        picksPerHour: 60,
        shift: [6, 18],
        stockShare: 0.4,
      },
    ],
    demand: {
      autonomous: true,
      ordersPerDay: 900,
      hourly,
      weekly,
      promotions: [
        {
          label: 'Black Friday',
          startsAfterHours: 30,
          durationHours: 12,
          multiplier: 6,
        },
      ],
    },
    ...shared,
    basket: { ...shared.basket, expressShare: 0.2 },
    customers: { returningShare: 0.4 },
    carriers: ukUsCarriers,
    returns: { ...shared.returns, approveRate: 0.97 },
    suppliers: {
      count: 6,
      profileMix: supplierMix,
      reorderBelowDays: 30,
      reorderCoverDays: 75,
      merchantReorders: true,
      leadTimeDays: 45,
      directory: ukUsSuppliers,
    },
    historyDays: 1,
  },
  'dach-beauty': {
    name: 'dach-beauty',
    label: 'DACH beauty brand',
    description:
      'German natural cosmetics brand on JTL-Wawi with DE and AT shops, one warehouse and drugstore wholesale orders. About 1,800 SKUs and 1,500 orders a day of low-priced products with few returns.',
    erp: 'jtl',
    company: {
      name: 'Alpenglow Naturkosmetik GmbH',
      city: 'Leipzig',
      language: 'de',
      mailbox: {
        address: 'einkauf@alpenglow.example',
        name: 'Alpenglow Einkauf',
      },
    },
    currency: { base: 'EUR', rates: {} },
    catalog: {
      ...sharedCatalog,
      products: 900,
      variantsPerProduct: [1, 3],
      categories: beautyCategories,
      daysOfCover: [20, 60],
    },
    shops: [
      {
        ...dach[0]!,
        instance: 'shopify-de',
        name: 'Alpenglow',
        domain: 'alpenglow-naturkosmetik.myshopify.com',
        orderShare: 0.8,
      },
      {
        ...dach[1]!,
        instance: 'shopify-at',
        name: 'Alpenglow AT',
        domain: 'alpenglow-naturkosmetik-at.myshopify.com',
        orderShare: 0.2,
        catalogShare: 0.85,
        priceFactor: 1,
        warehouse: '1',
      },
    ],
    warehouses: [
      {
        id: '1',
        name: 'Leipzig Logistikzentrum',
        city: 'Leipzig',
        timeZone: 'Europe/Berlin',
        picksPerHour: 180,
        shift: [6, 22],
        stockShare: 1,
      },
    ],
    demand: {
      autonomous: true,
      ordersPerDay: 1_500,
      hourly,
      weekly,
      promotions: [
        {
          label: 'Newsletter',
          startsAfterHours: 20,
          durationHours: 4,
          multiplier: 3,
          everyDays: 7,
        },
      ],
    },
    wholesale: {
      ordersPerDay: 12,
      accounts: 80,
      country: 'DE',
      warehouse: '1',
      linesPerOrder: [5, 25],
      unitsPerLine: [6, 36],
      priceFactor: 0.55,
      taxRate: 0.19,
      paymentDays: { medianMs: 21, p99Ms: 60 },
    },
    ...shared,
    basket: {
      lineWeights: [34, 30, 18, 10, 5, 3],
      quantityWeights: [70, 20, 7, 3],
      expressShare: 0.06,
    },
    customers: { returningShare: 0.55 },
    carriers: carriers.filter((carrier) => carrier.name !== 'Post CH'),
    returns: { ...shared.returns, approveRate: 0.9 },
    suppliers: {
      count: 6,
      profileMix: { ...supplierMix, partial: 0.18, full: 0.64 },
      reorderBelowDays: 14,
      reorderCoverDays: 45,
      merchantReorders: true,
      leadTimeDays: 21,
      directory: beautySuppliers,
    },
    historyDays: 2,
  },
} satisfies Record<string, MerchantProfile>;

export type MerchantProfileName = keyof typeof merchantProfiles;

/** Returns a copy of a preset that callers may change. */
export function merchantProfile(name: MerchantProfileName): MerchantProfile {
  return structuredClone(merchantProfiles[name]);
}
