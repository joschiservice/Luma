import {
  type InstallationCredentials,
  type InstallationInput,
  type InstalledConnection,
  installedConnectionSchema,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Returns the query-key prefix for one organization's installed connections. */
export const connectionsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'connections'] as const;

/**
 * Loads validated connections without retaining unused data or automatically retrying failed
 * reads.
 */
export const connectionsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: connectionsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.connections.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return result.body.items.map((item) =>
        installedConnectionSchema.parse(item),
      );
    },
  });

/**
 * Installs a connection and returns its validated public state; rejects unsuccessful API
 * responses.
 */
export async function installConnection(
  organizationId: string,
  body: InstallationInput,
) {
  const result = await api.connections.install({
    params: { organizationId },
    body,
  });
  if (result.status !== 201)
    throw new IdentityError(result.status, result.body);

  return installedConnectionSchema.parse(result.body);
}

/**
 * Checks, disconnects, or rotates a connection at its current version. Rotation requires
 * replacement credentials.
 */
export async function changeConnection(
  organizationId: string,
  connection: InstalledConnection,
  action: 'check' | 'disconnect' | 'rotate',
  credentials?: InstallationCredentials,
) {
  const params = { organizationId, connectionId: connection.id };
  const body = { version: connection.version };
  const result =
    action === 'rotate'
      ? await api.connections.rotate({
          params,
          body: { ...body, credentials: credentials! },
        })
      : await api.connections[action]({ params, body });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return installedConnectionSchema.parse(result.body);
}

/** Returns actionable connection feedback without exposing provider responses or credentials. */
export function connectionError(error: unknown) {
  const status = error instanceof IdentityError ? error.status : 0;
  if (status === 401) return 'Your session expired. Sign in again.';
  if (status === 403)
    return 'Permission denied. Ask a workspace owner or admin to manage connections.';
  if (status === 404)
    return 'This connection is no longer available. Refresh the list.';
  if (status === 409)
    return 'This connection changed. Refresh the list before trying again.';
  if (status === 400 || status === 422)
    return 'Check the connection details and enter the credentials again.';
  if (status === 503)
    return 'Connection service unavailable. Ask your administrator to check the provider setup, then refresh.';

  return 'The result could not be confirmed. Refresh the list before trying again.';
}
