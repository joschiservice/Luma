import {
  adaptiveAvailabilityRoutes,
  collectionRoutes,
  fieldsRoutes,
  operationalPackageRoutes,
  viewActionRoutes,
  viewsRoutes,
} from '@luma/adaptive/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/adaptive` serves. Missing services answer as unavailable. */
export function adaptiveHttp(services: AppDependencies) {
  return {
    adaptive: adaptiveAvailabilityRoutes(services.adaptive?.availability),
    adaptiveActions: viewActionRoutes(services.adaptive?.actions),
    adaptiveFields: fieldsRoutes(
      services.adaptive?.fields,
      services.fieldWorkflows,
    ),
    adaptivePackages: operationalPackageRoutes(services.adaptive?.packages),
    adaptiveViews: viewsRoutes(services.adaptive?.views),
    collections: collectionRoutes(
      services.adaptive?.collections,
      services.adaptive?.exports,
    ),
  };
}
