import type { TenantContext } from '@luma/identity';

import type { StockPosition } from '../domain/inventory.js';
import type {
  CollectionGroupedResult,
  CollectionListParameters,
} from './collections.js';

/** Listing fields compared across sources, in the order lists show and group them. */
export const catalogFields = [
  'title',
  'status',
  'published',
  'price',
  'barcode',
] as const;

export type CatalogField = (typeof catalogFields)[number];

/** Listing statuses in the order lists show and group them. */
export const catalogStatuses = [
  'active',
  'draft',
  'archived',
  'unknown',
] as const;

/** One source's current catalog entry for a canonical SKU. */
export type CatalogListing = {
  connectionId: string;
  productId: string;
  externalProduct: string | null;
  externalSku: string | null;
  code: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  status: 'active' | 'draft' | 'archived' | 'unknown';
  published: boolean | null;
  vendor: string | null;
  barcode: string | null;
  price: { amount: string; currency: string | null } | null;
  unit: string;
  observedAt: string;
  requiresComponents?: boolean | null;
  sourceUpdatedAt: string | null;
};

/** A catalog source whose current catalog does not contain the SKU. */
interface CatalogGap {
  connectionId: string;
  /** Another SKU in that source with the same normalized SKU code, not yet linked. */
  match: { skuId: string; sku: string } | null;
}

export interface CatalogItem {
  skuId: string;
  /** Source SKU code, or a readable canonical key when no source reports one. */
  sku: string;
  skuKey: string;
  title: string | null;
  listings: CatalogListing[];
  differences: CatalogField[];
  gaps: CatalogGap[];
}

/** A connection that has shared at least one product, with its catalog read state. */
export type CatalogSource = {
  connectionId: string;
  label: string;
  system: string | null;
  status: string;
  skuCount: number;
  /** When a full catalog read last completed; null means absence is not established. */
  fullReadAt: string | null;
  lastReadAt: string | null;
  failing: boolean;
};

export type CatalogView = 'all' | 'differs' | 'missing' | 'unlinked';

/**
 * Catalog orders. `price` is the lowest price in the alphabetically first reported currency;
 * `updated` the latest source update of any listing. SKUs without a value come last.
 */
export type ProductSort =
  'rank' | 'sku' | 'title' | 'price' | 'updated' | 'differences' | 'listings';

export interface ProductQuery extends CollectionListParameters {
  q: string;
  view: CatalogView;
  connectionId?: string | undefined;
  missingFrom?: string | undefined;
  /**
   * Defaults to `rank`: SKUs with a code, then with only a title, alphabetically.
   * `custom:<field ID>` sorts by a readable custom product field that holds one value.
   */
  sort?: ProductSort | `custom:${string}` | undefined;
  direction?: 'asc' | 'desc' | undefined;
  count?: 'exact' | undefined;
  cursor?: string | undefined;
  /** Page size, 1 to 50; defaults to 50. */
  limit?: number | undefined;
}

interface ProductList extends CollectionGroupedResult {
  items: CatalogItem[];
  sources: CatalogSource[];
  /** Matching SKUs per view for the current search, source filters and conditions. */
  counts: Record<CatalogView, number>;
  nextCursor: string | null;
  asOf: string;
}

export interface ProductSales {
  connectionId: string;
  unit: string;
  orders: number;
  quantity: string;
  lastPlacedAt: string | null;
  daily: { date: string; quantity: string }[];
}

/** Product detail sections that need another area's read permission. */
export type ProductDetailSection =
  'stock' | 'sales' | 'orders' | 'purchaseOrders' | 'issues';

export interface ProductDetail {
  /** Current catalog recipes, independent of previously sold order compositions. */
  bundles?: {
    connectionId: string;
    productId: string;
    variant: { externalId: string; scopeKey: string };
    requiresComponents: boolean;
    components:
      | {
          sourceId: { externalId: string; scopeKey: string };
          sourceVariant: { externalId: string; scopeKey: string };
          sourceSku: { externalId: string; scopeKey: string } | null;
          skuId: string | null;
          /** Current catalog label; it never establishes component identity. */
          skuLabel?: string | null;
          quantity: string;
        }[]
      | null;
    observedAt: string;
    sourceUpdatedAt: string | null;
  }[];
  item: CatalogItem;
  sources: CatalogSource[];
  variants: {
    skuId: string;
    sku: string;
    title: string | null;
    connectionId: string;
    status: CatalogListing['status'];
  }[];
  history: {
    entries: {
      id: string;
      connectionId: string;
      current: boolean;
      deleted: boolean;
      observedAt: string;
      sourceUpdatedAt: string | null;
      productTitle: string | null;
      status: CatalogListing['status'] | null;
      published: boolean | null;
      price: CatalogListing['price'];
      bundle?: Omit<
        NonNullable<ProductDetail['bundles']>[number],
        'connectionId' | 'productId' | 'observedAt' | 'sourceUpdatedAt'
      > | null;
    }[];
    truncated: boolean;
  };
  stock: StockPosition[];
  sales: { since: string; sources: ProductSales[] };
  orders: {
    id: string;
    label: string;
    status: string;
    connectionId: string;
    quantity: string;
    unit: string;
    placedAt: string | null;
  }[];
  purchaseOrders: {
    id: string;
    label: string;
    status: string;
    quantity: number;
    unit: string;
  }[];
  issues: { id: string; label: string; state: string }[];
  relatedTruncated: boolean;
  /** Sections left empty because the reader can't read their area. */
  hidden: ProductDetailSection[];
  asOf: string;
}

/**
 * Reads the tenant's product catalog by canonical SKU and compares each source's listing,
 * price and status without choosing an authoritative source. Requires `products.read`; detail
 * sections of other areas need their read permission.
 */
export interface ProductWorkspace {
  /** Returns up to `limit` SKUs. A cursor must belong to the same tenant and filters. */
  list(context: TenantContext, query: ProductQuery): Promise<ProductList>;
  /**
   * Returns a SKU's listings, related stock, sales, orders, supply and issues, or null when
   * the tenant has no such SKU.
   */
  get(context: TenantContext, skuId: string): Promise<ProductDetail | null>;
}
