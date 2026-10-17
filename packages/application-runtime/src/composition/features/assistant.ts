import { assistantRoutes } from '@luma/assistant/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/assistant` serves. Missing services answer as unavailable. */
export function assistantHttp(services: AppDependencies) {
  return {
    assistant: assistantRoutes(services.assistant),
  };
}
