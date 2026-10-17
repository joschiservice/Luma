import {
  type InstallationCredentials,
  type InstallationInput,
  type InstalledConnection,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { queryOptions } from '@tanstack/react-query';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { ApiError } from '../identity/data';

const api = createWebApiClient();

/** Returns the query-key prefix for one organization's installed connections. */
const connectionsKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'connections'] as const;

/**
 * Loads validated connections without retaining unused data or automatically retrying failed
 * reads.
 */
export const connectionsOptions = (organizationId: string) =>
  queryOptions({
    queryKey: connectionsKey(organizationId),
    ...privateQueryDefaults,
    queryFn: async ({ signal }) =>
      (await api.connections.list({ params: { organizationId } }, { signal }))
        .items,
  });

/**
 * Installs a connection and returns its validated public state; rejects unsuccessful API
 * responses.
 */
export async function installConnection(
  organizationId: string,
  body: InstallationInput,
) {
  return api.connections.install({ params: { organizationId }, body });
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

  return action === 'rotate'
    ? api.connections.rotate({
        params,
        body: { ...body, credentials: credentials! },
      })
    : api.connections[action]({ params, body });
}

/** Returns actionable connection feedback without exposing provider responses or credentials. */
export function connectionError(error: unknown) {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 401) return m.connections_error_session();
  if (status === 403) return m.connections_error_forbidden();
  if (status === 404) return m.connections_error_missing();
  if (status === 409) return m.connections_error_conflict();
  if (status === 400 || status === 422) return m.connections_error_invalid();
  if (status === 503) return m.connections_error_unavailable();

  return m.connections_error_unknown();
}

/** Owners impose observe-only or restore inheritance against the reviewed connection version. */
export async function changeConnectionWriteMode(
  organizationId: string,
  connection: InstalledConnection,
  writeMode: 'observe_only' | null,
) {
  return api.connections.updateWriteMode({
    params: { organizationId, connectionId: connection.id },
    body: { version: connection.version, writeMode },
  });
}
