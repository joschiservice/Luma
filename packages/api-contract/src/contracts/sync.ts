import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import { apiErrorSchema, organizationParamsSchema } from '../common.js';
import {
  identityDetailSchema,
  identityKindSchema,
  linkInputSchema,
  linkRequestSchema,
  syncCommandSchema,
  syncOverviewSchema,
  syncStreamSchema,
} from '../sync.js';

const c = initContract();

const errors = {
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  503: apiErrorSchema,
};

export const syncContract = c.router({
  overview: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/sync',
    pathParams: organizationParamsSchema,
    responses: { 200: syncOverviewSchema, ...errors },
    summary: 'Review imports and sync',
    description:
      'Shows, for each connection and record type, whether Luma is importing history, keeping records in sync, retrying or waiting for someone. Includes imported record counts, the creation-date range Luma holds, any source history limit, the last successful sync and recent runs. A record type is `not_requested` when the connection does not include it and `not_granted` when the source did not grant it.',
  },
  command: {
    method: 'POST',
    path: '/v1/organizations/:organizationId/sync/:streamId/commands',
    pathParams: organizationParamsSchema.extend({
      streamId: z.string().uuid(),
    }),
    body: syncCommandSchema,
    responses: { 200: syncStreamSchema, 400: apiErrorSchema, ...errors },
    summary: 'Control a sync',
    description:
      'Owners and admins can pause or resume a sync, retry now, request a full check against the source (`reconcile`) or import the history again (`reimport`). Resuming, retrying and re-importing continue with the caller’s access. Re-importing keeps every imported record; unchanged records are recognized and not duplicated. Commands are idempotent.',
  },
  identity: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/identities/:kind/:entityId',
    pathParams: organizationParamsSchema.extend({
      kind: identityKindSchema,
      entityId: z.string().uuid(),
    }),
    responses: { 200: identityDetailSchema, ...errors },
    summary: 'Inspect linked source records',
    description:
      'Lists the source records that represent one SKU, location or order, how each was linked, and possible matches in other sources. Suggestions share a SKU code or a JTL marketplace order reference; they are never linked automatically.',
  },
  requestLink: {
    method: 'POST',
    path: '/v1/organizations/:organizationId/identities/links',
    pathParams: organizationParamsSchema,
    body: linkInputSchema,
    responses: {
      202: linkRequestSchema,
      400: apiErrorSchema,
      422: apiErrorSchema,
      ...errors,
    },
    summary: 'Link or unlink source records',
    description:
      'Owners and admins can confirm that another SKU, location or order is the same record (`link`), or separate one connection’s source from it (`unlink`). Luma applies the change in the background, keeps the previous mapping as history and re-projects affected projections. Order links keep each source’s lines and shipments separate and preserve old references. Poll the returned request for its outcome.',
  },
  linkRequest: {
    method: 'GET',
    path: '/v1/organizations/:organizationId/identities/links/:requestId',
    pathParams: organizationParamsSchema.extend({
      requestId: z.string().uuid(),
    }),
    responses: { 200: linkRequestSchema, ...errors },
    summary: 'Check a link request',
    description:
      'Returns whether a link or unlink request is waiting, running, completed or failed, with an explanation when it failed.',
  },
});
