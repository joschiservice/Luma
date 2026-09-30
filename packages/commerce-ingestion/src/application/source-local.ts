import type { SourceIdentity } from '@luma/connections';

/**
 * The reconciliation key of a canonical entity that represents exactly one source record.
 * Another source joins it only through an explicit link.
 */
export function sourceLocalKey(source: SourceIdentity) {
  return JSON.stringify([
    'source',
    source.connectionId,
    source.resource,
    source.scopeKey,
    source.externalId,
  ]);
}
