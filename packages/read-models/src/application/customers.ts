import type { TenantContext } from '@luma/identity';

import type {
  CollectionGroupedResult,
  CollectionListParameters,
} from './collections.js';

/** Account states in the order the list groups them. */
export const customerStates = [
  'enabled',
  'disabled',
  'invited',
  'declined',
  'unknown',
] as const;

type CustomerState = (typeof customerStates)[number];

/** Built-in sorts of the customer list. */
export type CustomerSort =
  'created' | 'orders' | 'name' | 'amountSpent' | 'updated' | 'lastOrder';

/** One connection's current profile of one source customer, as last imported. */
export type CustomerListItem = {
  id: string;
  connectionId: string;
  externalId: string;
  /** Contact fields are null unless the source shares contact details. */
  displayName: string | null;
  email: string | null;
  phone: string | null;
  state: CustomerState;
  sourceCreatedAt: string | null;
  orderCount: number | null;
  amountSpent: { amount: string; currency: string } | null;
  tags: string[];
  shared: { contact: boolean; address: boolean };
  /** The shared address's country as reported, upper-cased; null unless the source shares it. */
  country: string | null;
  /**
   * Latest placed date of the orders this connection attributes to the customer; null when
   * none reports one. Omitted for readers without `orders.read`.
   */
  lastOrderAt?: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
  /**
   * When a complete full read first no longer found the customer; null while the source still
   * has them. Customers missing for 30 days are removed.
   */
  missingSince: string | null;
};

/** A commerce connection and whether it shares customers with Luma. */
export type CustomerSource = {
  connectionId: string;
  label: string;
  system: string | null;
  appId: string | null;
  status: string;
  /** `not_requested`: the connection was set up without customers, or its source cannot share them. */
  access: 'granted' | 'not_granted' | 'not_requested';
  records: number;
  importing: boolean;
  /** When a full read of customers last completed. */
  fullReadAt: string | null;
  lastReadAt: string | null;
  failing: boolean;
};

/**
 * List parameters. Conditions and groups follow the Customers catalog; contact and country
 * conditions never match customers whose source withholds those details.
 */
export interface CustomerQuery extends CollectionListParameters {
  q: string;
  state?: CustomerState | undefined;
  connectionId?: string | undefined;
  /** Finds one source customer; requires `connectionId`. */
  externalId?: string | undefined;
  /**
   * `amountSpent` orders by currency, then amount; `updated` by the source's last change;
   * `custom:<field ID>` by a readable single-value custom customer field. Profiles without a
   * value come last in both directions.
   */
  sort: CustomerSort | `custom:${string}`;
  direction: 'asc' | 'desc';
  count?: 'exact' | undefined;
  cursor?: string | undefined;
  /** Page size, 1 to 50. */
  limit: number;
}

interface CustomerList extends CollectionGroupedResult {
  items: CustomerListItem[];
  sources: CustomerSource[];
  /** Profiles matching the filters and conditions (and group, with `groupKey`), across all pages. */
  totalCount: number;
  nextCursor: string | null;
  asOf: string;
}

export interface CustomerDetail {
  item: CustomerListItem;
  /** Null unless the source shares addresses and reported one. */
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  source: CustomerSource | null;
  asOf: string;
}

/**
 * Reads imported customer profiles with the connections they came from. Profiles are never
 * merged across connections. Requires `customers.read`.
 */
export interface CustomerWorkspace {
  /**
   * Rejects a cursor produced by other filters, conditions, grouping or sorting, invalid
   * conditions and `externalId` without `connectionId` with a 400 error, and conditions,
   * groups or sorts on the last order date without `orders.read` with a 403 error.
   */
  list(context: TenantContext, query: CustomerQuery): Promise<CustomerList>;
  /** Returns null when the tenant has no profile with this ID. */
  get(context: TenantContext, id: string): Promise<CustomerDetail | null>;
}
