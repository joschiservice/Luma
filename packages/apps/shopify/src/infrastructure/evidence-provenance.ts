import { ConnectorError, type InvocationContext } from '@luma/connections';

/** A Shopify record a stored read or acceptance names. */
export interface EvidenceRecord {
  resource: string;
  externalId: string;
}

/**
 * Source identity, freshness and completeness a stored read keeps beside its normalized
 * document, as procurement and orders keep them for their reads. `sourceRevision` is Luma's
 * fingerprint of the read, because Shopify exposes no revision. A read is partial when a page
 * it needed was cut short.
 */
export interface ReadProvenance {
  adapterVersion: string;
  completeness: 'complete' | 'partial';
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  record: EvidenceRecord | null;
}

/**
 * The receipt fields of an accepted write: the adapter version and dispatch identity the
 * capability runtime pinned for the attempt, its idempotency key, and the Shopify records the
 * response named. Missing runtime fields stay null rather than guessed.
 */
export function acceptanceProvenance(
  context: InvocationContext,
  records: EvidenceRecord[],
) {
  return {
    adapterVersion: context.adapterVersion ?? null,
    dispatchIdentity: context.dispatchIdentity ?? null,
    idempotencyKey: context.idempotencyKey ?? null,
    records,
  };
}

/** Returns a Shopify timestamp in ISO form, or null when it is missing or not a valid time. */
export function sourceTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);

  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * Stores the receipt of a write Shopify accepted. A failed store must not be cited, so the
 * write counts as dispatched with an unknown outcome and is reconciled by reading.
 */
export async function storeAcceptance(store: () => Promise<void>) {
  try {
    await store();
  } catch {
    throw new ConnectorError({
      code: 'internal',
      effect: 'unknown',
      retry: 'reconcile',
      dispatch: 'dispatched',
    });
  }
}

/** True for a failure whose dispatch the handler already established, which callers rethrow. */
export function settledDispatch(error: unknown) {
  return (
    error instanceof ConnectorError &&
    (error.failure.dispatch === 'not_dispatched' ||
      error.failure.dispatch === 'dispatched')
  );
}
