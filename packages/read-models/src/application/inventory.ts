import type { TenantContext } from '@luma/identity';

import type { StockPosition, StockSource } from '../domain/inventory.js';
import type { TransferWorkspace } from './transfers.js';

export type { StockPosition, StockSource } from '../domain/inventory.js';

export interface InventoryQuery {
  q: string;
  view: 'all' | 'differs' | 'unknown';
  skuId?: string | undefined;
  locationId?: string | undefined;
  connectionId?: string | undefined;
  cursor?: string | undefined;
}

interface InventoryList {
  items: StockPosition[];
  nextCursor: string | null;
  asOf: string;
}

/** Stock detail sections that need another area's read permission. */
export type InventoryDetailSection = 'orders' | 'purchaseOrders' | 'issues';

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
  /** Sections left empty because the reader can't read their area. */
  hidden: InventoryDetailSection[];
  asOf: string;
}

/**
 * Reads stock by canonical SKU, location and unit while preserving each source's quantities.
 * Requires `inventory.read`; detail sections of other areas need their read permission.
 */
export interface InventoryWorkspace extends TransferWorkspace {
  /** Returns up to 50 positions. A cursor must belong to the same tenant and filters. */
  list(context: TenantContext, query: InventoryQuery): Promise<InventoryList>;
  /** Returns current facts, observed history and confirmed related work, or null when absent. */
  get(
    context: TenantContext,
    positionId: string,
  ): Promise<InventoryDetail | null>;
}
