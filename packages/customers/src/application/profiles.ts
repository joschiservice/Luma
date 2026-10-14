import type { TenantContext } from '@luma/identity';

import type {
  CustomerOrder,
  CustomerProfile,
  OrderAddresses,
} from '../domain/profiles.js';

interface CustomerProfileQuery {
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
   * whose customer was erased, lose their link. Each affected profile's last order date becomes
   * the latest reported placed date of its linked orders. Order keys must be unique. Requires
   * `sync.manage`.
   */
  recordOrders(
    context: TenantContext,
    connectionId: string,
    orders: Omit<CustomerOrder, 'connectionId'>[],
  ): Promise<void>;
  /**
   * Records the addresses one connection reports for its orders, replacing an order's stored
   * addresses unless they were observed later. Addresses of erased orders, and of orders whose
   * reported customer was erased, are removed instead of stored. Order keys must be unique.
   * Requires `sync.manage`.
   */
  recordOrderAddresses(
    context: TenantContext,
    connectionId: string,
    orders: OrderAddresses[],
  ): Promise<void>;
  /**
   * Deletes stored profiles, their order links and the addresses of their orders for one
   * connection, or only those of the listed source customers, and prevents listed customers and
   * their linked orders' addresses from being imported again. Requires `sync.manage`.
   */
  erase(
    context: TenantContext,
    connectionId: string,
    externalIds?: string[],
  ): Promise<number>;
  /**
   * Deletes the listed source customers' profiles and order links, for customers the source no
   * longer has. Order addresses stay: they belong to orders the source still reports. Unlike
   * `erase`, a later read that reports the customers again imports them again. Accepts up to
   * 1000 IDs. Requires `sync.manage`.
   */
  remove(
    context: TenantContext,
    connectionId: string,
    externalIds: string[],
  ): Promise<number>;
  /** Lists stored profiles for workspace members, newest source customers first. */
  list(
    context: TenantContext,
    query: CustomerProfileQuery,
  ): Promise<StoredCustomerProfile[]>;
}
