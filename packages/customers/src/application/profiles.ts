import type { TenantContext } from '@luma/identity';

import type { CustomerProfile } from '../domain/profiles.js';

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
   * Deletes stored profiles for one connection, or only the listed source customers, and
   * prevents listed customers from being imported again. Requires `sync.manage`.
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
