import { z } from 'zod';

import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  installationCredentials,
  installationInput,
  installedConnectionSchema,
} from '../connections.js';

export const connectionParams = organizationParamsSchema.extend({
  connectionId: z.string().uuid(),
});

export const connectionVersion = z
  .object({ version: z.number().int().positive() })
  .strict();

export const connectionsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/connections',
      summary: 'List installed organization connections',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 422, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(installedConnectionSchema) })),
  install: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/connections',
      successStatus: 201,
      summary: 'Install a connection',
      description:
        'Requires `connections.manage`. The connection remains pending until a successful permission check.',
    })
    .meta({
      access: requires('connections.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, body: installationInput }),
    )
    .output(installedConnectionSchema),
  check: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/connections/{connectionId}/check',
      summary: 'Validate credentials and requested permissions',
    })
    .meta({
      access: requires('connections.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(z.object({ params: connectionParams, body: connectionVersion }))
    .output(installedConnectionSchema),
  rotate: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/connections/{connectionId}/credentials',
      summary: 'Replace connection credentials',
      description:
        'Replaces credentials and clears verified permissions. Check the connection again to restore access. Also reconnects a connection whose provider revoked access, keeping its ID, mappings and history; a disconnected connection returns 409. Use the latest connection version.',
    })
    .meta({
      access: requires('connections.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: connectionParams,
        body: connectionVersion.extend({
          credentials: installationCredentials,
        }),
      }),
    )
    .output(installedConnectionSchema),
  disconnect: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/connections/{connectionId}/disconnect',
      summary: 'Disconnect an installed connection',
      description:
        'Deletes stored credentials and stops further use. Does not revoke provider tokens or cancel requests already sent. Install a new connection to reconnect.',
    })
    .meta({
      access: requires('connections.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(z.object({ params: connectionParams, body: connectionVersion }))
    .output(installedConnectionSchema),
};
