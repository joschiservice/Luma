import type { TenantDatabase } from '@luma/platform';

import type { AppFactoryContext } from './application/contracts.js';
import { createAppService as service } from './application/installations.js';
import type { AppRegistry } from './application/registry.js';
import { createAppRepository } from './infrastructure/installations.js';

/** Composes persistent app installations with authorization and registered lifecycle hooks. */
export function createAppService(
  database: TenantDatabase,
  registry: AppRegistry,
  refreshContext: AppFactoryContext['refreshContext'],
) {
  return service(createAppRepository(database), registry, refreshContext);
}
