import type { FastifyInstance } from 'fastify';

import { registerAuthHandler } from './api/auth-handler.js';
import type { createIdentity } from './composition.js';

export { identityRoutes, registerIdentityGuards } from './api/routes.js';

/** Registers authentication endpoints on the owning HTTP server. */
export function registerIdentityHttp(
  app: FastifyInstance,
  identity: ReturnType<typeof createIdentity>,
) {
  identity.onDatabaseError(() =>
    app.log.error('Identity database connection failed'),
  );
  registerAuthHandler(app, identity.handler, identity.baseURL);
}

export { rolesRoutes } from './api/roles.js';

export { settingsRoutes } from './api/settings.js';
