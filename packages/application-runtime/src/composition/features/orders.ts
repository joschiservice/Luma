import { returnCaseRoutes } from '@luma/orders/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/orders` serves. Missing services answer as unavailable. */
export function ordersHttp(services: AppDependencies) {
  return {
    returnCases: returnCaseRoutes(
      services.returnCases,
      services.returnActions,
      services.returnExchanges,
      services.returnDeadlines,
    ),
  };
}
