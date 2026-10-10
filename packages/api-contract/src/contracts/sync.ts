import { z } from 'zod';

import {
  anyMember,
  endpoint,
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

export const syncContract = {
  autoLinkRules: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/sync/automatic-links',
      summary: 'Review automatic linking rules',
      description:
        'Lists connection-pair rules for SKU codes and ERP order references to Shopify orders, with their last check, total links and any reason they are waiting or blocked.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(autoLinkRulesSchema),
  previewAutoLinks: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/sync/automatic-links/preview',
      summary: 'Preview automatic links',
      description:
        'Requires Manage imports. Shows counts and up to 20 examples for the selected record type and connections. Does not link records. Duplicate codes or references, conflicting mappings or units, manually separated records and stale or missing evidence are skipped.',
    })
    .meta({
      access: requires('sync.manage'),
      errors: [400, 401, 403, 404, 422, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, body: autoLinkPairSchema }),
    )
    .output(autoLinkPreviewSchema),
  saveAutoLinkRule: endpoint
    .route({
      method: 'PUT',
      path: '/v1/organizations/{organizationId}/sync/automatic-links',
      summary: 'Configure automatic linking',
      description:
        'Requires Manage imports. Creates a rule with revision zero, or enables or disables an existing rule using its current revision. Each save is audited and enabled rules run with the caller’s current access. Disabling stops future links and keeps existing links. SKU rules require unique normalized codes and compatible units; order rules match an ERP order’s explicit external order number, as JTL and Cin7 report it, to one selected Shopify store. Every application rechecks current evidence and preserves mapping history.',
    })
    .meta({
      access: requires('sync.manage'),
      errors: [400, 401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, body: autoLinkInputSchema }),
    )
    .output(autoLinkRuleSchema),
  overview: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/sync',
      summary: 'Review imports and sync',
      description:
        'Shows, for each connection and record type, whether Luma is importing history, keeping records in sync, retrying or waiting for someone. Includes imported record counts, the creation-date range Luma holds, any source history limit, the last successful sync and recent runs. A record type is `not_requested` when the connection does not include it and `not_granted` when the source did not grant it.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(z.object({ params: organizationParamsSchema }))
    .output(syncOverviewSchema),
  command: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/sync/{streamId}/commands',
      summary: 'Control a sync',
      description:
        'Requires `sync.manage`. Pauses or resumes a sync, retries now, requests a full check against the source (`reconcile`) or imports the history again (`reimport`). Resuming, retrying and re-importing continue with the caller’s access. Re-importing keeps every imported record; unchanged records are recognized and not duplicated. Commands are idempotent.',
    })
    .meta({
      access: requires('sync.manage'),
      errors: [400, 401, 403, 404, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          streamId: z.string().uuid(),
        }),
        body: syncCommandSchema,
      }),
    )
    .output(syncStreamSchema),
  identity: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/identities/{kind}/{entityId}',
      summary: 'Inspect linked source records',
      description:
        'Lists the source records that represent one SKU, location or order, how each was linked, and possible matches in other sources. Suggestions share a SKU code or an ERP order’s marketplace order reference. Configured automatic linking rules may apply unambiguous matches; other suggestions require review.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          kind: identityKindSchema,
          entityId: z.string().uuid(),
        }),
      }),
    )
    .output(identityDetailSchema),
  requestLink: endpoint
    .route({
      method: 'POST',
      path: '/v1/organizations/{organizationId}/identities/links',
      successStatus: 202,
      summary: 'Link or unlink source records',
      description:
        'Requires `sync.manage`. Confirms that another SKU, location or order is the same record (`link`), or separates one connection’s source from it (`unlink`). Luma applies the change in the background, keeps the previous mapping as history and re-projects affected projections. Order links keep each source’s lines and shipments separate and preserve old references. Poll the returned request for its outcome.',
    })
    .meta({
      access: requires('sync.manage'),
      errors: [400, 401, 403, 404, 422, 503],
    })
    .input(
      z.object({ params: organizationParamsSchema, body: linkInputSchema }),
    )
    .output(linkRequestSchema),
  linkRequest: endpoint
    .route({
      method: 'GET',
      path: '/v1/organizations/{organizationId}/identities/links/{requestId}',
      summary: 'Check a link request',
      description:
        'Returns whether a link or unlink request is waiting, running, completed or failed, with an explanation when it failed.',
    })
    .meta({ access: anyMember, errors: [401, 403, 404, 503] })
    .input(
      z.object({
        params: organizationParamsSchema.extend({
          requestId: z.string().uuid(),
        }),
      }),
    )
    .output(linkRequestSchema),
};
