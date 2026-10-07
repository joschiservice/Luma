import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  installationCredentials,
  installationInput,
  installedConnectionSchema,
} from '../connections.js';

const c = initContract();

export const connectionParams = organizationParamsSchema.extend({
  connectionId: z.string().uuid(),
});

export const connectionVersion = z
  .object({ version: z.number().int().positive() })
  .strict();

export const connectionsContract = c.router(
  {
    list: {
      method: 'GET',
      metadata: anyMember,
      path: '/v1/organizations/:organizationId/connections',
      pathParams: organizationParamsSchema,
      responses: {
        200: z.object({ items: z.array(installedConnectionSchema) }),
      },
      summary: 'List installed organization connections',
    },
    install: {
      method: 'POST',
      metadata: requires('connections.manage'),
      path: '/v1/organizations/:organizationId/connections',
      pathParams: organizationParamsSchema,
      body: installationInput,
      responses: { 201: installedConnectionSchema },
      summary: 'Install a connection',
      description:
        'Requires `connections.manage`. The connection remains pending until a successful permission check.',
    },
    check: {
      method: 'POST',
      metadata: requires('connections.manage'),
      path: '/v1/organizations/:organizationId/connections/:connectionId/check',
      pathParams: connectionParams,
      body: connectionVersion,
      responses: { 200: installedConnectionSchema },
      summary: 'Validate credentials and requested permissions',
    },
    rotate: {
      method: 'POST',
      metadata: requires('connections.manage'),
      path: '/v1/organizations/:organizationId/connections/:connectionId/credentials',
      pathParams: connectionParams,
      body: connectionVersion.extend({ credentials: installationCredentials }),
      responses: { 200: installedConnectionSchema },
      summary: 'Replace connection credentials',
      description:
        'Replaces credentials and clears verified permissions. Check the connection again to restore access. Also reconnects a connection whose provider revoked access, keeping its ID, mappings and history; a disconnected connection returns 409. Use the latest connection version.',
    },
    disconnect: {
      method: 'POST',
      metadata: requires('connections.manage'),
      path: '/v1/organizations/:organizationId/connections/:connectionId/disconnect',
      pathParams: connectionParams,
      body: connectionVersion,
      responses: { 200: installedConnectionSchema },
      summary: 'Disconnect an installed connection',
      description:
        'Deletes stored credentials and stops further use. Does not revoke provider tokens or cancel requests already sent. Install a new connection to reconnect.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
