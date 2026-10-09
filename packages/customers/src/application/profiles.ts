import type { TenantContext } from '@luma/identity';

import type { CustomerOrder, CustomerProfile } from '../domain/profiles.js';

export interface CustomerProfileQuery {
  /** Matches the start of a name or email address, case-insensitively. */
  q?: string;
  connectionId?: string;
  limit: number;
}

export interface StoredCustomerProfile extends CustomerProfile {
  /** Stable Luma ID for this connection's customer. */
  id: string;
  updatedAt: string;
}

export interface CustomerProfiles {
  /**
   * Stores the profile when it is newer than the stored one; requires `sync.manage`.
   * Returns `suppressed` without storing when the customer's data was erased.
   */
  upsert(
    context: TenantContext,
    profile: CustomerProfile,
  ): Promise<'applied' | 'retained' | 'suppressed'>;
  /**
   * Records which source customer placed each order of one connection, replacing an order's
   * earlier customer unless the stored link was observed later. Orders without a customer, or
   * whose customer was erased, lose their link. Order keys must be unique. Requires `sync.manage`.
   */
  recordOrders(
    context: TenantContext,
    connectionId: string,
    orders: Omit<CustomerOrder, 'connectionId'>[],
  ): Promise<void>;
  /**
   * Deletes stored profiles and their order links for one connection, or only those of the
   * listed source customers, and prevents listed customers from being imported again.
   * Requires `sync.manage`.
   */
  erase(
    context: TenantContext,
    connectionId: string,
    externalIds?: string[],
  ): Promise<number>;
  /** Lists stored profiles for workspace members, newest source customers first. */
  list(
    context: TenantContext,
    query: CustomerProfileQuery,
  ): Promise<StoredCustomerProfile[]>;
}
