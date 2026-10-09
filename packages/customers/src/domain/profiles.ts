/** A postal address as the source reported it; every field may be absent. */
export interface CustomerAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/**
 * The current profile one connection reports for one source customer. Contact and address
 * fields are null unless the source shared them; `shared` says which groups it shared.
 */
export interface CustomerProfile {
  connectionId: string;
  /** Case-preserved source customer ID. */
  externalId: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  address: CustomerAddress | null;
  state: 'enabled' | 'disabled' | 'invited' | 'declined' | 'unknown';
  sourceCreatedAt: string | null;
  orderCount: number | null;
  amountSpent: { amount: string; currency: string } | null;
  tags: string[];
  shared: { contact: boolean; address: boolean };
  /** Source modification time; null when the source does not report one. */
  sourceUpdatedAt: string | null;
  /** When Luma started the read that produced this profile, on Luma's clock. */
  observedAt: string;
  observationId: string;
}

type Version = Pick<
  CustomerProfile,
  'observationId' | 'sourceUpdatedAt' | 'observedAt'
>;

/**
 * Decides whether an incoming profile replaces the stored one. Two source update times
 * compare strictly; otherwise the later read wins. Source and Luma clocks are never compared.
 */
export function replacesProfile(incoming: Version, current: Version) {
  if (incoming.observationId === current.observationId) return false;
  if (incoming.sourceUpdatedAt && current.sourceUpdatedAt)
    return (
      Date.parse(incoming.sourceUpdatedAt) > Date.parse(current.sourceUpdatedAt)
    );

  return Date.parse(incoming.observedAt) > Date.parse(current.observedAt);
}

/**
 * The source customer one connection reports for one of its orders, as of `observedAt`.
 * `customerExternalId` is null for guest orders and orders without a customer.
 */
export interface CustomerOrder {
  connectionId: string;
  order: { externalId: string; scopeKey: string };
  customerExternalId: string | null;
  observedAt: string;
}
