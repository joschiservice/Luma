import type { StockOwnershipScope } from './native-stock.js';

/** Server-captured publication binding; account identities and versions must come from the owner read. */
export interface NativePublicationBinding {
  scope: StockOwnershipScope;
  authorityRevision: number;
  skuId: string;
  locationId: string;
  unit: string;
  available: string;
  accounts: { id: string; balance: string; version: string }[];
  openingReviewIds: string[];
}
