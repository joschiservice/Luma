import { initContract } from '@ts-rest/core';
import { z } from 'zod';

import {
  anyMember,
  apiErrorSchema,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  autoLinkInputSchema,
  autoLinkPairSchema,
  autoLinkPreviewSchema,
  autoLinkRuleSchema,
  autoLinkRulesSchema,
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
  autoLinkRules: {
    method: 'GET',
    metadata: anyMember,
    path: '/v1/organizations/:organizationId/sync/automatic-links',
    pathParams: organizationParamsSchema,
    responses: { 200: autoLinkRulesSchema, ...errors },
    summary: 'Review automatic linking rules',
    description:
      'Lists connection-pair rules for SKU codes and JTL references to Shopify orders, with their last check, total links and any reason they are waiting or blocked.',
  },
  previewAutoLinks: {
    method: 'POST',
    metadata: requires('sync.manage'),
    path: '/v1/organizations/:organizationId/sync/automatic-links/preview',
    pathParams: organizationParamsSchema,
    body: autoLinkPairSchema,
    responses: {
      200: autoLinkPreviewSchema,
      400: apiErrorSchema,
      422: apiErrorSchema,
      ...errors,
    },
    summary: 'Preview automatic links',
    description:
      'Requires Manage imports. Shows counts and up to 20 examples for the selected record type and connections. Does not link records. Duplicate codes or references, conflicting mappings or units, manually separated records and stale or missing evidence are skipped.',
  },
  saveAutoLinkRule: {
    method: 'PUT',
    metadata: requires('sync.manage'),
    path: '/v1/organizations/:organizationId/sync/automatic-links',
    pathParams: organizationParamsSchema,
    body: autoLinkInputSchema,
    responses: {
      200: autoLinkRuleSchema,
      400: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
      ...errors,
    },
    summary: 'Configure automatic linking',
    description:
      'Requires Manage imports. Creates a rule with revision zero, or enables or disables an existing rule using its current revision. Each save is audited and enabled rules run with the caller’s current access. Disabling stops future links and keeps existing links. SKU rules require unique normalized codes and compatible units; order rules match an explicit JTL external order number to one selected Shopify store. Every application rechecks current evidence and preserves mapping history.',
  },
  overview: {
    method: 'GET',
    metadata: anyMember,
    path: '/v1/organizations/:organizationId/sync',
    pathParams: organizationParamsSchema,
    responses: { 200: syncOverviewSchema, ...errors },
    summary: 'Review imports and sync',
    description:
      'Shows, for each connection and record type, whether Luma is importing history, keeping records in sync, retrying or waiting for someone. Includes imported record counts, the creation-date range Luma holds, any source history limit, the last successful sync and recent runs. A record type is `not_requested` when the connection does not include it and `not_granted` when the source did not grant it.',
  },
  command: {
    method: 'POST',
    metadata: requires('sync.manage'),
    path: '/v1/organizations/:organizationId/sync/:streamId/commands',
    pathParams: organizationParamsSchema.extend({
      streamId: z.string().uuid(),
    }),
    body: syncCommandSchema,
    responses: { 200: syncStreamSchema, 400: apiErrorSchema, ...errors },
    summary: 'Control a sync',
    description:
      'Requires `sync.manage`. Pauses or resumes a sync, retries now, requests a full check against the source (`reconcile`) or imports the history again (`reimport`). Resuming, retrying and re-importing continue with the caller’s access. Re-importing keeps every imported record; unchanged records are recognized and not duplicated. Commands are idempotent.',
  },
  identity: {
    method: 'GET',
    metadata: anyMember,
    path: '/v1/organizations/:organizationId/identities/:kind/:entityId',
    pathParams: organizationParamsSchema.extend({
      kind: identityKindSchema,
      entityId: z.string().uuid(),
    }),
    responses: { 200: identityDetailSchema, ...errors },
    summary: 'Inspect linked source records',
    description:
      'Lists the source records that represent one SKU, location or order, how each was linked, and possible matches in other sources. Suggestions share a SKU code or a JTL marketplace order reference. Configured automatic linking rules may apply unambiguous matches; other suggestions require review.',
  },
  requestLink: {
    method: 'POST',
    metadata: requires('sync.manage'),
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
      'Requires `sync.manage`. Confirms that another SKU, location or order is the same record (`link`), or separates one connection’s source from it (`unlink`). Luma applies the change in the background, keeps the previous mapping as history and re-projects affected projections. Order links keep each source’s lines and shipments separate and preserve old references. Poll the returned request for its outcome.',
  },
  linkRequest: {
    method: 'GET',
    metadata: anyMember,
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
