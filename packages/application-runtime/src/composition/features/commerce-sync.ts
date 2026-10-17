import { syncRoutes } from '@luma/commerce-sync/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/commerce-sync` serves. Missing services answer as unavailable. */
export function commerceSyncHttp(services: AppDependencies) {
  return {
    sync: syncRoutes(services.sync),
  };
}
