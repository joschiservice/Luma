import { randomUUID } from 'node:crypto';

import type { FeatureFlag, Observability } from '@luma/platform';

/** Evaluates a server release for an authorized tenant, defaulting off when telemetry is absent. */
export function createTenantFeatureRelease(observability?: Observability) {
  return async (tenantId: string, flag: FeatureFlag): Promise<boolean> => {
    if (!observability) return false;
    const observation = observability.request(randomUUID());
    try {
      return await observability.flag(
        observability.forTenant(
          observation.context,
          tenantId,
          observability.dataRegion ?? 'AU',
        ),
        flag,
        false,
      );
    } finally {
      observation.end();
    }
  };
}
