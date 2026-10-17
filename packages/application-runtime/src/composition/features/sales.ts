import { salesRoutes } from '@luma/sales/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/sales` serves. Missing services answer as unavailable. */
export function salesHttp(services: AppDependencies) {
  return {
    sales: salesRoutes(services.sales),
  };
}
