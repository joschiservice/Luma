import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { appManifestSchema, workspaceAppSchema } from '../apps.js';
import { apiErrorSchema, organizationParamsSchema } from '../common.js';

const params = organizationParamsSchema.extend({
  appId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});

export const appsContract = initContract().router(
  {
    list: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/apps',
      pathParams: organizationParamsSchema,
      responses: {
        200: z.object({
          catalog: z.array(appManifestSchema),
          installations: z.array(workspaceAppSchema),
        }),
      },
      summary: 'List available apps and workspace installations',
    },
    install: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/apps/:appId/install',
      pathParams: params,
      body: z.object({ version: z.number().int().positive().nullable() }),
      responses: { 200: workspaceAppSchema },
      summary: 'Install an app in this workspace',
      description:
        'Owners and admins can install an available app. Use null for a first installation or the current version to reinstall.',
    },
    uninstall: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/apps/:appId/uninstall',
      pathParams: params,
      body: z.object({ version: z.number().int().positive() }),
      responses: { 200: workspaceAppSchema },
      summary: 'Uninstall an app',
      description:
        'Stops new app operations and deletes its connection credentials. Historical records remain. Requests already dispatched may finish.',
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
