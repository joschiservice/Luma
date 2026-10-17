import { caseRoutes } from '@luma/exceptions/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/exceptions` serves. Missing services answer as unavailable. */
export function exceptionsHttp(services: AppDependencies) {
  return {
    exceptions: caseRoutes(services.cases),
  };
}
