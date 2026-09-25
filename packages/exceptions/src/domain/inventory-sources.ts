import type { DiagnosisInput } from './diagnosis.js';

/** Resolves comparison sides from their recorded connection IDs, independent of evidence order. */
export function inventorySources(snapshot: DiagnosisInput | null) {
  if (snapshot?.input.exceptionClass !== 'inventory_mismatch') return null;
  const { connectionIds, evidenceRefs } = snapshot.input.facts;
  const provider = (connectionId: string) => {
    const names = new Set(
      snapshot.evidence
        .filter(
          (entry) =>
            entry.connectionId === connectionId &&
            entry.tenantId === snapshot.input.facts.tenantId &&
            evidenceRefs.includes(entry.key),
        )
        .flatMap((entry) => (entry.source ? [entry.source.provider] : [])),
    );

    return names.size === 1 ? [...names][0]! : null;
  };

  return {
    left: provider(connectionIds[0]),
    right: provider(connectionIds[1]),
  };
}
