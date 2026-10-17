import {
  activityRoutes,
  deskRoutes,
  learningRoutes,
  operationsRoutes,
  playbookRoutes,
  shadowRoutes,
} from '@luma/resolution/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/resolution` serves. Missing services answer as unavailable. */
export function resolutionHttp(services: AppDependencies) {
  return {
    activity: activityRoutes(services.activity),
    caseDesk: deskRoutes(services.desk),
    operations: operationsRoutes(services.operations, services.measurements),
    playbooks: playbookRoutes(services.playbooks),
    resolutionLearning: learningRoutes(services.learning),
    shadow: shadowRoutes(services.shadow),
  };
}
