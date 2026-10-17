import type { AcceptedRecord, WriteCapability } from './capabilities.js';

/**
 * A provider's confirmed acceptance of one dispatched write, as the capability runtime hands it
 * to the owner that stores and cites it. Acceptance is not verification. A write whose response
 * was lost or unreadable has no acceptance, so nothing is stored or cited for it.
 */
export interface WriteAcceptance {
  provider: string;
  connectionId: string;
  capability: WriteCapability;
  adapterVersion: string;
  /** The provider and adapter identity execution pinned for the attempt. */
  dispatchIdentity: string;
  /** Execution's logical key for the attempt; one proposal has one dispatch. */
  idempotencyKey: string;
  /** When the response arrived, on Luma's clock. */
  acceptedAt: string;
  providerRequestId: string | null;
  records: AcceptedRecord[];
}

/**
 * A stored write receipt: the normalized acceptance without the provider payload. Its ID is the
 * reference execution attempts and their audit entries cite.
 */
export interface WriteReceiptEvidence {
  kind: 'write_receipt';
  id: string;
  source: { provider: string; connectionId: string };
  capability: WriteCapability;
  adapterVersion: string;
  dispatchIdentity: string;
  idempotencyKey: string;
  /** When the acceptance arrived. */
  observedAt: string;
  /** The provider confirmed acceptance; the business outcome still needs verification. */
  status: 'accepted';
  providerRequestId: string | null;
  records: AcceptedRecord[];
}

/** Builds the stored form of an acceptance under the owner's receipt ID. */
export function writeReceiptEvidence(
  id: string,
  acceptance: WriteAcceptance,
): WriteReceiptEvidence {
  return {
    kind: 'write_receipt',
    id,
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
