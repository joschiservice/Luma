import { messagingRoutes } from '@luma/messaging/http';

import type { AppDependencies } from '../http-app.js';

/** Implements the routes `@luma/messaging` serves. Missing services answer as unavailable. */
export function messagingHttp(services: AppDependencies) {
  return {
    messaging: messagingRoutes(
      services.messaging,
      services.messagingReplies,
      services.messagingDocuments,
    ),
  };
}
