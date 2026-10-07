import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  appManifestSchema,
  workspaceAppSchema,
  workspaceAppStateSchema,
} from '../apps.js';
import {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';

const params = organizationParamsSchema.extend({
  appId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});

export const appsContract = initContract().router(
  {
    list: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/apps',
      pathParams: organizationParamsSchema,
      metadata: anyMember,
      responses: {
        200: z.object({
          catalog: z.array(appManifestSchema),
          installations: z.array(workspaceAppStateSchema),
        }),
      },
      summary: 'List available apps and workspace installations',
      description:
        'Includes the permissions each app declares, the access it requests, the scopes granted to each installation and roles that hold its permissions.',
    },
    install: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/apps/:appId/install',
      pathParams: params,
      metadata: requires('apps.manage'),
      body: z.object({
        version: z.number().int().positive().nullable(),
        /** Exactly the scopes the manifest requests, as reviewed by the installer. */
        scopes: z.array(z.string()).max(100),
      }),
      responses: { 200: workspaceAppSchema },
      summary: 'Install an app in this workspace',
      description:
        'Requires `apps.manage` and every scope the app requests: you can only grant access you have. Send the requested scopes you reviewed; a changed request returns 409. Use null for a first installation or the current version to reinstall. Reinstalling restores no role permissions.',
    },
    approveScopes: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/apps/:appId/scopes',
      pathParams: params,
      metadata: requires('apps.manage'),
      body: z.object({
        version: z.number().int().positive(),
        scopes: z.array(z.string()).min(1).max(100),
      }),
      responses: { 200: workspaceAppSchema },
      summary: 'Approve access an upgraded app requests',
      description:
        'Requires `apps.manage` and each approved scope. Until approved, the app keeps working with the scopes granted earlier.',
    },
    uninstall: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/apps/:appId/uninstall',
      pathParams: params,
      metadata: requires('apps.manage'),
      body: z.object({ version: z.number().int().positive() }),
      responses: { 200: workspaceAppSchema },
      summary: 'Uninstall an app',
      description:
        'Requires `apps.manage`. Stops new app operations, deletes connection credentials and scope grants, and removes the app’s permissions from every role. Historical records remain. Requests already dispatched may finish.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);
