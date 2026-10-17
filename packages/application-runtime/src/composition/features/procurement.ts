import {
  procurementRoutes,
  purchaseOrderChangeRoutes,
  scopedFollowUpRoutes,
  supplierEmailRoutes,
} from '@luma/procurement/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/procurement` serves. Missing services answer as unavailable. */
export function procurementHttp(services: AppDependencies) {
  return {
    procurement: procurementRoutes(
      services.procurement,
      services.commitments,
      services.supplierTerms,
      services.purchasing,
      services.purchasingOutcomes,
      services.incoming,
    ),
    procurementChanges: purchaseOrderChangeRoutes(services.orderChanges),
    procurementEmail: supplierEmailRoutes(
      services.supplierEmail,
      services.procurement,
    ),
    scopedFollowUps: scopedFollowUpRoutes(services.governedFollowUps),
  };
}
