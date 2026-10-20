import type { Permission, TenantContext } from '@luma/identity';

/** The permission that reveals changes of each record type: the one its own routes require. */
export const changeReadPermissions = {
  order: 'orders.read',
  fulfillment: 'fulfillment.read',
  return: 'returns.read',
  inventory: 'inventory.read',
  product: 'products.read',
  customer: 'customers.read',
  returnCase: 'returns.read',
  issue: 'issues.read',
} as const satisfies Record<string, Permission>;

export type ChangeRecordType = keyof typeof changeReadPermissions;

/** One recorded change: which record, and whether it still exists. */
export interface ChangeItem {
  type: ChangeRecordType;
  id: string;
  operation: 'upserted' | 'deleted';
  recordedAt: string;
}

/** A page of the change feed and the cursor to continue from. */
interface ChangePage {
  items: ChangeItem[];
  cursor: string;
  hasMore: boolean;
}

/** Reads which public records of a workspace changed, in commit order. */
export interface ChangeFeed {
  /**
   * Returns up to `limit` changes after the cursor `after`, of the requested types or of every
   * type the reader can read. Without `after`, returns no changes and the current position.
   * Throws 403 for a requested type the reader can't read, 400 for a malformed cursor and 410
   * for a cursor older than the retained changes.
   */
  list(
    context: TenantContext,
    query: {
      after?: string | undefined;
      types?: ChangeRecordType[] | undefined;
      limit: number;
    },
  ): Promise<ChangePage>;
}
