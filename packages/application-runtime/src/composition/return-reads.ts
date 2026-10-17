import type { CitedRead, Observation } from '@luma/connections';
import type { ReturnRead } from '@luma/orders/composition';

/** The orders view of a provider read that return evidence cites; orders stores it as is. */
export function returnRead(
  observation: Observation<unknown>,
  completeness: CitedRead['completeness'],
): ReturnRead {
  const { source } = observation;

  return {
    id: observation.id,
    source: {
      provider: source.provider,
      connectionId: source.connectionId,
      resource: source.resource,
      externalId: source.externalId,
      scopeKey: source.scopeKey,
    },
    observedAt: observation.observedAt,
    sourceUpdatedAt: observation.sourceUpdatedAt,
    sourceRevision: observation.sourceRevision,
    adapterVersion: observation.adapterVersion,
    completeness,
    data: observation.data,
  };
}

/** The orders view of the reads an aggregate provider result cites. */
export function citedReturnReads(reads: readonly CitedRead[]) {
  return reads.map((read) => returnRead(read, read.completeness));
}
