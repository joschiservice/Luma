import { z } from 'zod';

import {
  adaptivePackageRequestSchema,
  adaptivePackageReviewSchema,
  adaptivePackageSummarySchema,
} from '../adaptive-packages.js';
import { endpoint, organizationParamsSchema, requires } from '../common.js';

const params = organizationParamsSchema.extend({
  packageId: z.string().regex(/^[a-z][a-z0-9-]{1,80}$/),
});
const path = '/v1/organizations/{organizationId}/adaptive/packages';
const meta = {
  access: requires('adaptive.packages.manage'),
  errors: [401, 403, 404, 409, 422, 503],
} as const;

export const adaptivePackagesContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary:
        'Read operational packages and installed workspace configuration',
    })
    .meta(meta)
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ items: z.array(adaptivePackageSummarySchema) })),
  preview: endpoint
    .route({
      method: 'POST',
      path: `${path}/{packageId}/preview`,
      summary: 'Review package additions and missing requirements',
    })
    .meta({ ...meta, readOnly: true })
    .input(z.object({ params, body: adaptivePackageRequestSchema }))
    .output(adaptivePackageReviewSchema),
  install: endpoint
    .route({
      method: 'POST',
      path: `${path}/{packageId}/install`,
      summary:
        'Install reviewed package definitions without activating workflows or granting access',
    })
    .meta(meta)
    .input(
      z.object({
        params,
        body: adaptivePackageRequestSchema.extend({
          commandId: z.string().uuid(),
          reviewDigest: z.string().min(1).max(128),
        }),
      }),
    )
    .output(adaptivePackageSummarySchema),
  uninstall: endpoint
    .route({
      method: 'POST',
      path: `${path}/{packageId}/uninstall`,
      summary:
        'Remove package definitions while retaining business records and audit history',
    })
    .meta(meta)
    .input(
      z.object({
        params,
        body: z
          .object({
            commandId: z.string().uuid(),
            revision: z.number().int().positive(),
          })
          .strict(),
      }),
    )
    .output(z.object({ removed: z.literal(true) })),
};
