import { customerErasureRoutes } from '@luma/customers/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/customers` serves. Missing services answer as unavailable. */
export function customersHttp(services: AppDependencies) {
  return {
    customerErasures: customerErasureRoutes(services.customerErasure),
  };
}
