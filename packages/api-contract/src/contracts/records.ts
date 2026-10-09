import { z } from 'zod';

import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  recordDetailSchema,
  recordKindSchema,
  recordListSchema,
  recordQuerySchema,
} from '../records.js';

export const recordsContract = {
  resolve: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/record-source',
      summary: 'Resolve a source order',
      description:
        'Finds an order by its exact connection and source ID. No IDs means it has not been mapped. Two IDs indicate an ambiguous mapping; do not select one automatically.',
    })
    .meta({ access: requires('orders.read'), errors: [400, 401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema,
        query: z
          .object({
            connectionId: z.string().uuid(),
            kind: z.literal('order'),
            externalId: z.string().min(1).max(512),
          })
          .strict(),
      }),
    )
    .output(z.object({ ids: z.array(z.string().uuid()).max(2) })),
  list: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/records',
      summary: 'Search workspace records',
      description:
        'Searches current records in your workspace, most recently observed first. Filter by connection to inspect one source. Each page holds up to 50 records with source identity, freshness and coverage; pass `nextCursor` as `cursor` to read the next page. A cursor from a different search returns 400. Customer and return coverage is unavailable.',
    })
    .meta({ access: anyMember, errors: [400, 401, 404, 503] })
    .input(
      z.object({ params: organizationParamsSchema, query: recordQuerySchema }),
    )
    .output(recordListSchema),
  get: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/records/{kind}/{recordId}',
      summary: 'Inspect a workspace record',
      description:
        'Returns the current source snapshots and confirmed related records. Each source remains separate so differing or uncertain mappings are visible.',
    })
    .meta({ access: anyMember, errors: [401, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          kind: recordKindSchema,
          recordId: z.string().uuid(),
        }),
      }),
    )
    .output(recordDetailSchema),
};
