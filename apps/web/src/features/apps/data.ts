import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { IdentityError } from '../identity/data';

const api = createWebApiClient();

/** Search state for returning from an app's authorization flow. */
export const appResultSearch = z.object({
  appResult: z
    .enum(['connected', 'denied', 'permissions', 'failed'])
    .optional()
    .catch(undefined),
});

/** Loads current app availability and installations for one workspace. */
export function appsOptions(organizationId: string) {
  return queryOptions({
    queryKey: ['private', 'organization', organizationId, 'apps'],
    ...privateQueryDefaults,
    queryFn: async ({ signal }) => {
      const result = await api.apps.list({
        params: { organizationId },
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.status !== 200)
        throw new IdentityError(result.status, result.body);

      return result.body;
    },
  });
}

/**
 * Installs an app, granting the scopes the installer reviewed, or uninstalls it at its current
 * workspace version.
 */
export async function changeApp(
  organizationId: string,
  appId: string,
  action: 'install' | 'uninstall',
  version: number | null,
  scopes: readonly string[] = [],
) {
  const params = { organizationId, appId };
  const result =
    action === 'install'
      ? await api.apps.install({
          params,
          body: { version, scopes: [...scopes] },
        })
      : await api.apps.uninstall({ params, body: { version: version! } });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return result.body;
}

/** Grants access an upgraded app requests; earlier grants keep working until then. */
export async function approveAppScopes(
  organizationId: string,
  appId: string,
  version: number,
  scopes: readonly string[],
) {
  const result = await api.apps.approveScopes({
    params: { organizationId, appId },
    body: { version, scopes: [...scopes] },
  });
  if (result.status !== 200)
    throw new IdentityError(result.status, result.body);

  return result.body;
}
