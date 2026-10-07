import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  recordDetailSchema,
  recordKindSchema,
  recordListSchema,
  recordQuerySchema,
} from '../records.js';

const c = initContract();

export const recordsContract = c.router({
  resolve: {
    method: 'GET',
    metadata: requires('orders.read'),
    path: '/v1/organizations/:organizationId/record-source',
    pathParams: organizationParamsSchema,
    query: z
      .object({
        connectionId: z.string().uuid(),
        kind: z.literal('order'),
        externalId: z.string().min(1).max(512),
      })
      .strict(),
    responses: {
      200: z.object({ ids: z.array(z.string().uuid()).max(2) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Resolve a source order',
    description:
      'Finds an order by its exact connection and source ID. No IDs means it has not been mapped. Two IDs indicate an ambiguous mapping; do not select one automatically.',
  },
  list: {
    method: 'GET',
    metadata: anyMember,
    path: '/v1/organizations/:organizationId/records',
    pathParams: organizationParamsSchema,
    query: recordQuerySchema,
    responses: {
      200: recordListSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Search workspace records',
    description:
      'Searches current records in your workspace, most recently observed first. Filter by connection to inspect one source. Each page holds up to 50 records with source identity, freshness and coverage; pass `nextCursor` as `cursor` to read the next page. A cursor from a different search returns 400. Customer and return coverage is unavailable.',
  },
  get: {
    method: 'GET',
    metadata: anyMember,
    path: '/v1/organizations/:organizationId/records/:kind/:recordId',
    pathParams: organizationParamsSchema.extend({
      kind: recordKindSchema,
      recordId: z.string().uuid(),
    }),
    responses: {
      200: recordDetailSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: 'Inspect a workspace record',
    description:
      'Returns the current source snapshots and confirmed related records. Each source remains separate so differing or uncertain mappings are visible.',
  },
});
