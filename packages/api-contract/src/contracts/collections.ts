import { z } from 'zod';

import { adaptiveViewQuerySchema } from '../adaptive-view-query.js';
import {
  collectionDomainSchema,
  collectionMemberStateResponseSchema,
  saveCollectionMemberStateSchema,
} from '../collections.js';
import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';

const path = '/v1/organizations/{organizationId}/collections';
const params = organizationParamsSchema.extend({
  domain: collectionDomainSchema,
});
const access = { access: anyMember, errors: [401, 403, 404, 503] } as const;

export const collectionsContract = {
  state: endpoint
    .route({
      method: 'GET',
      path: `${path}/{domain}/state`,
      summary: 'Read your list state',
      description:
        'Returns what you last had open on a list page in this workspace: the view, unsaved changes, your default view, view order and personal display settings. `state` is null until you change something on the page. Requires read access to the list.',
    })
    .meta(access)
    .input(z.object({ params }))
    .output(collectionMemberStateResponseSchema),
  saveState: endpoint
    .route({
      method: 'PUT',
      path: `${path}/{domain}/state`,
      summary: 'Save your list state',
      description:
        'Replaces your state for one list page. Send a `sequence` higher than the last one this client sent; a save with a lower or equal sequence than the stored one is ignored and the stored state is returned. Search text and page position are not part of the state. Read-only support views cannot save.',
    })
    .meta(access)
    .input(z.object({ params, body: saveCollectionMemberStateSchema }))
    .output(collectionMemberStateResponseSchema),
  resetState: endpoint
    .route({
      method: 'DELETE',
      path: `${path}/{domain}/state`,
      summary: 'Reset a list page to its default',
      description:
        'Removes your remembered state and personal display settings for one list page. The page then opens your default view, or the built-in default.',
    })
    .meta(access)
    .input(z.object({ params }))
    .output(collectionMemberStateResponseSchema),
  export: endpoint
    .route({
      method: 'POST',
      path: `${path}/{domain}/export`,
      summary: 'Export a list as CSV',
      description:
        'Exports the visible columns of a list query as CSV, reading the same records the list shows. Needs permission to export lists and to read the list; read-only support views cannot export. At most 5,000 rows are exported; `truncated` says when the list has more, and the file ends with the `@truncated` label. Send column headings in `labels`, keyed by column ID. Every export is recorded in the audit log without its values.',
    })
    .meta({
      access: requires('lists.export'),
      errors: [401, 403, 404, 422, 503],
    })
    .input(
      z.object({
        params,
        body: z
          .object({
            query: adaptiveViewQuerySchema,
            labels: z
              .record(z.string().max(140), z.string().max(200))
              .refine((labels) => Object.keys(labels).length <= 60),
          })
          .strict(),
      }),
    )
    .output(
      z.object({
        filename: z.string(),
        csv: z.string(),
        rows: z.number().int().nonnegative(),
        truncated: z.boolean(),
      }),
    ),
  resetAll: endpoint
    .route({
      method: 'DELETE',
      path: `${path}/state`,
      summary: 'Reset all list settings',
      description:
        'Removes your remembered state and personal display settings for every list page in this workspace. Saved views are not changed.',
    })
    .meta(access)
    .input(z.object({ params: organizationParamsSchema }))
    .output(z.object({ removed: z.number().int().nonnegative() })),
};
