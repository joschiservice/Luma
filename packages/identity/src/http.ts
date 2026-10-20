import type { FastifyInstance } from 'fastify';

import { registerAuthHandler } from './api/auth-handler.js';
import { registerMailEvents } from './api/mail-events.js';
import type { createIdentity } from './composition.js';

export { registerContractRoutes } from './api/contract-routes.js';

export type { HttpContext } from './api/contract-routes.js';

export { identityRoutes, registerIdentityGuards } from './api/routes.js';

export {
  requestIsReadOnly,
  restrictRequestToReads,
  runInRequestScope,
} from './api/request-scope.js';

/**
 * Registers authentication endpoints on the owning HTTP server, and the email delivery event
 * endpoint when a Resend webhook secret is configured.
 */
export function registerIdentityHttp(
  app: FastifyInstance,
  identity: ReturnType<typeof createIdentity>,
) {
  identity.onDatabaseError(() =>
    app.log.error('Identity database connection failed'),
  );
  registerAuthHandler(
    app,
    identity.handler,
    identity.baseURL,
    identity.regionConfig,
    identity.clientIpHeader,
  );
  if (identity.mailEvents)
    registerMailEvents(app, (payload, headers) =>
      identity.mailEvents!.receive(payload, headers),
    );
}

export { apiAppsRoutes } from './api/api-apps.js';

export { rolesRoutes } from './api/roles.js';

export { settingsRoutes } from './api/settings.js';
