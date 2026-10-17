/**
 * A mailbox provider's confirmed acceptance of one reply send, as the capability runtime reports
 * it. Acceptance is not verification: the thread read still has to find the message. A send
 * whose response was lost has no acceptance, so nothing is stored or cited for it.
 */
export interface SendAcceptance {
  provider: string;
  connectionId: string;
  capability: string;
  adapterVersion: string;
  /** The provider and adapter identity execution pinned for the attempt. */
  dispatchIdentity: string;
  /** Execution's logical key for the attempt; one reply action has one send. */
  idempotencyKey: string;
  /** When the response arrived, on Luma's clock. */
  acceptedAt: string;
  providerRequestId: string | null;
  /** Provider records the response named, such as the sent message and its thread. */
  records: { resource: string; externalId: string }[];
}

/**
 * A stored send receipt: the normalized acceptance, without recipients, subject or text. Its ID
 * is the reference the execution attempt and its audit entry cite. The shape matches the write
 * receipts other owners store.
 */
export interface SendReceipt {
  kind: 'write_receipt';
  id: string;
  tenantId: string;
  outboundId: string;
  threadId: string;
  source: { provider: string; connectionId: string };
  capability: string;
  adapterVersion: string;
  dispatchIdentity: string;
  idempotencyKey: string;
  /** When the acceptance arrived. */
  observedAt: string;
  /** The provider confirmed acceptance; the send still needs verification. */
  status: 'accepted';
  providerRequestId: string | null;
  records: { resource: string; externalId: string }[];
}

/** Builds the stored receipt for one accepted reply send under the given ID. */
export function sendReceipt(
  tenantId: string,
  outbound: { id: string; threadId: string },
  id: string,
  acceptance: SendAcceptance,
): SendReceipt {
  return {
    kind: 'write_receipt',
    id,
    tenantId,
    outboundId: outbound.id,
    threadId: outbound.threadId,
    source: {
      provider: acceptance.provider,
      connectionId: acceptance.connectionId,
    },
    capability: acceptance.capability,
    adapterVersion: acceptance.adapterVersion,
    dispatchIdentity: acceptance.dispatchIdentity,
    idempotencyKey: acceptance.idempotencyKey,
    observedAt: acceptance.acceptedAt,
    status: 'accepted',
    providerRequestId: acceptance.providerRequestId,
    records: acceptance.records.map(({ resource, externalId }) => ({
      resource,
      externalId,
    })),
  };
}
