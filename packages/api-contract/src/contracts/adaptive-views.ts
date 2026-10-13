import { z } from 'zod';

import {
  adaptiveViewDraftSchema,
  adaptiveViewInputSchema,
  adaptiveViewPreviewSchema,
  adaptiveViewQuerySchema,
  adaptiveViewRevisionSchema,
  adaptiveViewSchema,
  builtInAdaptiveViewSchema,
} from '../adaptive-views.js';
import { anyMember, endpoint, organizationParamsSchema } from '../common.js';

const path = '/v1/organizations/{organizationId}/adaptive/views';
const params = organizationParamsSchema.extend({ viewId: z.string().uuid() });
const access = {
  access: anyMember,
  errors: [401, 403, 404, 409, 422, 503],
} as const;

export const adaptiveViewsContract = {
  list: endpoint
    .route({ method: 'GET', path, summary: 'Browse saved views' })
    .meta(access)
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.object({
        items: z.array(adaptiveViewSchema),
        builtIns: z.array(builtInAdaptiveViewSchema),
      }),
    ),
  get: endpoint
    .route({
      method: 'GET',
      path: `${path}/{viewId}`,
      summary: 'Read a saved view',
    })
    .meta(access)
    .input(z.object({ params }))
    .output(adaptiveViewSchema),
  create: endpoint
    .route({ method: 'POST', path, summary: 'Save a reviewed live query' })
    .meta(access)
    .input(
      z.object({
        params: organizationParamsSchema,
        body: adaptiveViewInputSchema,
      }),
    )
    .output(adaptiveViewSchema),
  update: endpoint
    .route({
      method: 'PUT',
      path: `${path}/{viewId}`,
      summary: 'Revise a saved view',
    })
    .meta(access)
    .input(
      z.object({
        params,
        body: adaptiveViewInputSchema.extend({
          expectedRevision: z.number().int().positive(),
        }),
      }),
    )
    .output(adaptiveViewSchema),
  archive: endpoint
    .route({
      method: 'POST',
      path: `${path}/{viewId}/archive`,
      summary: 'Archive a saved view',
    })
    .meta(access)
    .input(
      z.object({
        params,
        body: z
          .object({ expectedRevision: z.number().int().positive() })
          .strict(),
      }),
    )
    .output(adaptiveViewSchema),
  duplicate: endpoint
    .route({
      method: 'POST',
      path: `${path}/{viewId}/duplicate`,
      summary: 'Copy a saved query to a private view',
    })
    .meta(access)
    .input(
      z.object({
        params,
        body: z
          .object({
            commandId: z.string().uuid(),
            name: z.string().trim().min(1).max(120),
          })
          .strict(),
      }),
    )
    .output(adaptiveViewSchema),
  history: endpoint
    .route({
      method: 'GET',
      path: `${path}/{viewId}/history`,
      summary: 'Read saved view revisions',
    })
    .meta(access)
    .input(z.object({ params }))
    .output(
      z.object({
        items: z.array(adaptiveViewRevisionSchema),
        truncated: z.boolean(),
      }),
    ),
  preview: endpoint
    .route({
      method: 'POST',
      path: `${path}/preview`,
      summary: 'Preview a live query',
      description:
        'Runs validated filters through record owners. Incomplete evidence and unsupported fields are reported explicitly; no action executes.',
    })
    .meta({ ...access, readOnly: true })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z
          .object({
            query: adaptiveViewQuerySchema,
            cursor: z.string().min(1).max(8192).optional(),
            selectedRecordIds: z
              .array(z.string().uuid())
              .min(1)
              .max(100)
              .optional(),
          })
          .strict(),
      }),
    )
    .output(adaptiveViewPreviewSchema),
  generate: endpoint
    .route({
      method: 'POST',
      path: `${path}/generate`,
      summary: 'Draft a view from a description',
      description:
        'Proposes a constrained query and preview. Saving requires explicit review. Ambiguous identities and unsupported requests need clarification.',
    })
    .meta(access)
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z.object({ prompt: z.string().trim().min(1).max(2000) }).strict(),
      }),
    )
    .output(adaptiveViewDraftSchema),
};
