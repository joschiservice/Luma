import { z } from 'zod';

import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';
import {
  stockProtectionIncidentSchema,
  stockProtectionQuerySchema,
  stockProtectionSettingsSchema,
  stockProtectionViewSchema,
} from '../stock-protection.js';

const path = '/v1/organizations/{organizationId}/apps/shopify/stock-protection';

/** Stock protection is off by default; every command rechecks installation, release and authority. */
export const stockProtectionContract = {
  view: endpoint
    .route({
      method: 'POST',
      path: `${path}-view`,
      summary: 'Read stock protection settings and incidents',
    })
    .meta({
      access: requires('inventory.read'),
      readOnly: true,
      errors: [401, 403, 404, 409, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: stockProtectionQuerySchema,
      }),
    )
    .output(stockProtectionViewSchema),
  save: endpoint
    .route({
      method: 'POST',
      path: `${path}-save`,
      summary: 'Configure stock protection for one store',
      description:
        'Enabling preauthorizes bounded incident holds and releases. Send the last read revision. Disabling active holds requires release or keep until recovery.',
    })
    .meta({
      access: requires('workspace.approval_policy.manage'),
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z
          .object({
            settings: stockProtectionSettingsSchema,
            activeHolds: z.enum(['release', 'keep']).optional(),
          })
          .strict(),
      }),
    )
    .output(stockProtectionSettingsSchema),
  control: endpoint
    .route({
      method: 'POST',
      path: `${path}-control`,
      summary: 'Release, extend or approve stock protection',
    })
    .meta({
      access: anyMember,
      errors: [401, 403, 404, 409, 422, 503],
    })
    .input(
      z.object({
        params: organizationParamsSchema,
        body: z
          .object({
            id: z.string().uuid(),
            action: z.enum(['release', 'extend', 'approve', 'reject']),
            holdId: z.string().uuid().optional(),
          })
          .strict(),
      }),
    )
    .output(stockProtectionIncidentSchema),
};
