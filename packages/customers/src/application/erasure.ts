import type { TenantContext } from '@luma/identity';

/** The customer an erasure applies to. */
interface CustomerErasureTarget {
  connectionId: string;
  /** The customer's ID in the connected system, whether or not Luma imported a profile. */
  externalId: string;
  /** Further addresses of the customer to erase from the inbox, beyond the stored profile's. */
  emails: string[];
}

/** A data-subject erasure of one source customer of one connection. */
interface CustomerErasureRequest extends CustomerErasureTarget {
  /** Command ID; a retry with the same ID and customer returns the original result. */
  id: string;
}

/** What an erasure removes or changes. */
export interface CustomerErasureResult {
  /** Stored profiles removed; 0 when Luma held none. */
  profiles: number;
  /** Inbox messages to or from the customer. */
  messages: number;
  /** Threads whose subject, participants or correspondent change. */
  threads: number;
  /** Replies addressed to the customer; unsent ones are withheld. */
  replies: number;
  /** Mailbox rules for the customer's address that are removed. */
  rules: number;
}

export interface CustomerErasure {
  /**
   * Reports what `erase` would remove now, without changing anything. Requires
   * `customers.erase`. Returns null when the connection is not the workspace's.
   */
  preview(
    context: TenantContext,
    target: CustomerErasureTarget,
  ): Promise<CustomerErasureResult | null>;
  /**
   * Erases the customer's profile, order links and order addresses, prevents their import again,
   * and erases their inbox data: message and attachment content, addresses, display names,
   * subjects, the party facts that name them and mailbox rules for their address. Refuses
   * support views. Requires `customers.erase`, re-checked against the current membership.
   * Writes an audit entry with the counts but without the customer's identifiers in the same
   * transaction. Returns null when the connection is not the workspace's; reusing a command ID
   * for another customer fails with 409.
   */
  erase(
    context: TenantContext,
    request: CustomerErasureRequest,
  ): Promise<CustomerErasureResult | null>;
}
