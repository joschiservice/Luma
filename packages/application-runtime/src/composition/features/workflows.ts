import {
  draftTestRoutes,
  workflowDraftRoutes,
  workflowGenerationRoutes,
  workflowRoutes,
} from '@luma/workflows/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/workflows` serves. Missing services answer as unavailable. */
export function workflowsHttp(services: AppDependencies) {
  return {
    draftTests: draftTestRoutes(services.draftTests),
    workflowDrafts: workflowDraftRoutes(
      services.workflowDrafts,
      services.workflowTemplates,
    ),
    workflowGeneration: workflowGenerationRoutes(services.workflowGeneration),
    workflows: workflowRoutes(services.workflows),
  };
}
