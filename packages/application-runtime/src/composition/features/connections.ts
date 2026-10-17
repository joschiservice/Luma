import {
  connectionRoutes,
  createConnectors,
  sourceAuthorityRoutes,
  sourceEnvironmentRoutes,
} from '@luma/connections/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/connections` serves. Missing services answer as unavailable. */
export function connectionsHttp(services: AppDependencies) {
  return {
    connections: connectionRoutes(
      services.connections,
      services.sales?.enabled,
      services.connectionCoverage,
    ),
    connectorProviders: createConnectors(services.providerCatalog),
    sourceAuthority: sourceAuthorityRoutes(services.sourceAuthority),
    sourceEnvironments: sourceEnvironmentRoutes(services.sourceEnvironments),
  };
}
