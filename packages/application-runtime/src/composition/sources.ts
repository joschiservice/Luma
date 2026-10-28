import { randomBytes } from 'node:crypto';

import type { ProviderCatalog } from '@luma/connections';
import {
  createOrderSourceVisibility,
  createSourceAuthority,
} from '@luma/connections/composition';
import type { IdentityService } from '@luma/identity';
import type { Observability, TenantDatabase } from '@luma/platform';

/**
 * Composes which sources a workspace sees and trusts. `erpEnabledForTenant` reads the
 * `luma-erp-orders` flag per call and is false without observability; `authority` builds a source
 * authority reader on the given database, classifying `luma-erp` as the ERP and other providers by
 * their catalog category.
 */
export function createSourceServices(options: {
  database: TenantDatabase;
  identity: Pick<IdentityService, 'refreshContext'>;
  providerCatalog: ProviderCatalog | undefined;
  observability: Observability | undefined;
}) {
  const { database, identity } = options;
  const erpEnabledForTenant = async (tenantId: string) => {
    const observation = options.observability?.request(
      randomBytes(16).toString('hex'),
    );
    if (!observation || !options.observability) return false;
    try {
      const trace = options.observability.forTenant(
        observation.context,
        tenantId,
        options.observability.dataRegion ?? 'AU',
      );

      return await options.observability.flag(trace, 'luma-erp-orders', false);
    } finally {
      observation.end();
    }
  };
  const hiddenOrderSources = createOrderSourceVisibility(
    database,
    erpEnabledForTenant,
  );
  const authority = (scoped: TenantDatabase) =>
    createSourceAuthority(
      scoped,
      (provider) =>
        provider === 'luma-erp'
          ? 'erp'
          : (options.providerCatalog?.get(provider)?.category ?? null),
      identity.refreshContext,
      erpEnabledForTenant,
    );

  return { authority, erpEnabledForTenant, hiddenOrderSources };
}
