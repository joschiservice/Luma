import { z } from 'zod';

import { adaptiveViewQueryInputSchema } from '../adaptive-view-query.js';
import {
  adaptiveViewDraftSchema,
  adaptiveViewInputSchema,
  adaptiveViewPreviewSchema,
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
    .route({
      method: 'GET',
      path,
      summary: 'Browse saved views',
      description:
        'Lists live views you own or that are shared with you, and the built-in views your role can read. Queries are returned in format 2; views stored in format 1 are upgraded on read.',
    })
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
      description:
        'Returns the view with its query in format 2. A condition, sort or grouping that no longer matches the list needs repair before the view can be previewed.',
    })
    .meta(access)
    .input(z.object({ params }))
    .output(adaptiveViewSchema),
  create: endpoint
    .route({
      method: 'POST',
      path,
      summary: 'Save a reviewed live query',
      description:
        'Accepts a query in format 2, or format 1 for compatibility, and stores it in format 2. Conditions, sorting and grouping must use the list catalog; unknown columns are kept and shown as unavailable. Repeating a command with the same content returns the saved view.',
    })
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
      description:
        'Accepts a query in format 2 or 1 and stores a new revision in format 2. A stale `expectedRevision` is refused with 409.',
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
      description:
        'Copies the query in format 2. Actions you cannot invoke are left out of the copy.',
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
      description:
        'Returns up to 100 revisions, newest first. Revisions stored in format 1 are upgraded to format 2 on read.',
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
        "Runs a query in format 2 or 1 through the record owners. Rows are keyed by the list catalog's column IDs. Incomplete evidence and unavailable columns are reported explicitly; a condition the list cannot yet run is refused with 422. No action executes.",
    })
    .meta({ ...access, readOnly: true })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z
          .object({
            query: adaptiveViewQueryInputSchema,
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
        'Proposes a constrained query in format 2 and its preview. Saving requires explicit review. Ambiguous identities and unsupported requests need clarification.',
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
