import type { TenantContext } from '@luma/identity';

import type { StockPosition, StockSource } from '../domain/inventory.js';

export type { StockPosition, StockSource } from '../domain/inventory.js';

export interface InventoryQuery {
  q: string;
  view: 'all' | 'differs' | 'unknown';
  skuId?: string | undefined;
  locationId?: string | undefined;
  connectionId?: string | undefined;
  cursor?: string | undefined;
}

export interface InventoryList {
  items: StockPosition[];
  nextCursor: string | null;
  asOf: string;
}

export interface InventoryDetail {
  position: StockPosition;
  history: {
    entries: (StockSource & { id: string; current: boolean })[];
    truncated: boolean;
  };
  orders: {
    id: string;
    label: string;
    status: string;
    connectionId: string;
    quantity: string;
    unit: string;
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
  asOf: string;
}

/** Reads stock by canonical SKU, location and unit while preserving each source's quantities. */
export interface InventoryWorkspace {
  /** Returns up to 50 positions. A cursor must belong to the same tenant and filters. */
  list(context: TenantContext, query: InventoryQuery): Promise<InventoryList>;
  /** Returns current facts, observed history and confirmed related work, or null when absent. */
  get(
    context: TenantContext,
    positionId: string,
  ): Promise<InventoryDetail | null>;
}
