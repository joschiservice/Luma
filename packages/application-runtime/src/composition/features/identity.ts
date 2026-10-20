import {
  apiAppsRoutes,
  identityRoutes,
  rolesRoutes,
  settingsRoutes,
} from '@luma/identity/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/identity` serves. Missing services answer as unavailable. */
export function identityHttp(services: AppDependencies) {
  return {
    apiApps: apiAppsRoutes(services.apiApps),
    identity: identityRoutes(services.identity),
    roles: rolesRoutes(services.roles),
    settings: settingsRoutes(services.settings),
  };
}
