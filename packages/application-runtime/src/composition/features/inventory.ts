import { nativeStockRoutes } from '@luma/inventory/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/inventory` serves. Missing services answer as unavailable. */
export function inventoryHttp(services: AppDependencies) {
  return {
    nativeStock: nativeStockRoutes(services.nativeStock),
  };
}
