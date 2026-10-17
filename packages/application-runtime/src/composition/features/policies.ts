import { scopedAutonomyRoutes } from '@luma/policies/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/policies` serves. Missing services answer as unavailable. */
export function policiesHttp(services: AppDependencies) {
  return {
    scopedAutonomy: scopedAutonomyRoutes(services.scopedAutonomy),
  };
}
