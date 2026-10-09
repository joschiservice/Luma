import { z } from 'zod';

import {
  appManifestSchema,
  workspaceAppSchema,
  workspaceAppStateSchema,
} from '../apps.js';
import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';

const params = organizationParamsSchema.extend({
  appId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});

export const appsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/apps',
      summary: 'List available apps and workspace installations',
      description:
        'Includes the permissions each app declares, the access it requests, the scopes granted to each installation and roles that hold its permissions.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 409, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.object({
        catalog: z.array(appManifestSchema),
        installations: z.array(workspaceAppStateSchema),
      }),
    ),
  install: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/apps/{appId}/install',
      summary: 'Install an app in this workspace',
      description:
        'Requires `apps.manage` and every scope the app requests: you can only grant access you have. Send the requested scopes you reviewed; a changed request returns 409. Use null for a first installation or the current version to reinstall. Reinstalling restores no role permissions.',
    })
    .meta({
      access: requires('apps.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params,
        body: z.object({
          version: z.number().int().positive().nullable(),
          /** Exactly the scopes the manifest requests, as reviewed by the installer. */
          scopes: z.array(z.string()).max(100),
        }),
      }),
    )
    .output(workspaceAppSchema),
  approveScopes: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/apps/{appId}/scopes',
      summary: 'Approve access an upgraded app requests',
      description:
        'Requires `apps.manage` and each approved scope. Until approved, the app keeps working with the scopes granted earlier.',
    })
    .meta({
      access: requires('apps.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params,
        body: z.object({
          version: z.number().int().positive(),
          scopes: z.array(z.string()).min(1).max(100),
        }),
      }),
    )
    .output(workspaceAppSchema),
  uninstall: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/apps/{appId}/uninstall',
      summary: 'Uninstall an app',
      description:
        'Requires `apps.manage`. Stops new app operations, deletes connection credentials and scope grants, and removes the app’s permissions from every role. Historical records remain. Requests already dispatched may finish.',
    })
    .meta({
      access: requires('apps.manage'),
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: params,
        body: z.object({ version: z.number().int().positive() }),
      }),
    )
    .output(workspaceAppSchema),
};
