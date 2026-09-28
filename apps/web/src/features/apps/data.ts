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
      if (result.status !== 200) throw new IdentityError(result.status);

      return result.body;
    },
  });
}

/** Installs or uninstalls an app using its current workspace version. */
export async function changeApp(
  organizationId: string,
  appId: string,
  action: 'install' | 'uninstall',
  version: number | null,
) {
  const params = { organizationId, appId };
  const result =
    action === 'install'
      ? await api.apps.install({ params, body: { version } })
      : await api.apps.uninstall({ params, body: { version: version! } });
  if (result.status !== 200) throw new IdentityError(result.status);

  return result.body;
}
