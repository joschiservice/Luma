import { z } from 'zod';

import {
  anyMember,
  endpoint,
  organizationParamsSchema,
  requires,
} from '../common.js';

const path = '/v1/organizations/{organizationId}/api-apps';
const appParams = organizationParamsSchema.extend({
  appId: z.string().uuid(),
});
const command = z.object({ 'x-command-id': z.string().uuid() });
const errors = [401, 403, 404, 409, 422, 503] as const;

/** Days a new or rotated API token stays valid. */
export const apiAppLifetimeDays = [7, 30, 90, 180, 365] as const;

const lifetimeSchema = z
  .number()
  .int()
  .refine(
    (value) => apiAppLifetimeDays.some((days) => days === value),
    'Choose 7, 30, 90, 180 or 365 days.',
  );

const apiAppSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** Permissions the app was granted; it uses those the person's role still grants. */
  scopes: z.array(z.string()),
  status: z.enum(['active', 'expired', 'revoked']),
  owner: z.object({ userId: z.string().uuid(), name: z.string().nullable() }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  /** The token's last four characters, to recognize it. */
  lastFour: z.string().nullable(),
  revokedAt: z.string().datetime().nullable(),
  /**
   * Requests in the last 30 days that read customer personal data, and the records they
   * returned. Counted for orders, customers and returns while the app could read customers.
   */
  personalDataReads: z.object({
    requests: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
  }),
});

export type ApiApp = z.infer<typeof apiAppSchema>;

const issuedSchema = z.object({
  app: apiAppSchema,
  /**
   * The token, shown only in this response. It is null when a repeated `x-command-id` returned
   * the original result; rotate the app to get a new token.
   */
  token: z.string().nullable(),
});

export const apiAppsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'List API apps',
      description:
        'Lists your personal API apps and the permissions API apps can be granted. People with `apps.manage` see every API app in the workspace. Each app reports how many requests read customer personal data in the last 30 days and how many records they returned. Tokens are never returned.',
    })
    .meta({ access: anyMember, errors })
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.object({
        items: z.array(apiAppSchema),
        /**
         * Permissions API apps can be granted. `sensitive` ones read personal data; a person
         * grants only those they hold.
         */
        scopes: z.array(z.object({ key: z.string(), sensitive: z.boolean() })),
      }),
    ),
  create: endpoint
    .route({
      method: 'POST',
      path,
      successStatus: 201,
      summary: 'Create a personal API app',
      description:
        'Creates an app that acts for you through a bearer token, limited to the permissions you choose from those you hold. The token is returned once. Requires `api_apps.create`; only a signed-in person can create API apps.',
    })
    .meta({ access: requires('api_apps.create'), errors })
    .input(
      z.object({
        params: organizationParamsSchema,
        headers: command,
        body: z
          .object({
            name: z.string().trim().min(1).max(80),
            scopes: z.array(z.string().max(120)).min(1).max(50),
            lifetimeDays: lifetimeSchema,
          })
          .strict(),
      }),
    )
    .output(issuedSchema),
  rotate: endpoint
    .route({
      method: 'POST',
      path: `${path}/{appId}/rotate`,
      summary: 'Replace an API app’s token',
      description:
        'Issues a new token and stops the previous one immediately. Only the person the app acts for can rotate it. The token is returned once.',
    })
    .meta({ access: requires('api_apps.create'), errors })
    .input(
      z.object({
        params: appParams,
        headers: command,
        body: z.object({ lifetimeDays: lifetimeSchema }).strict(),
      }),
    )
    .output(issuedSchema),
  revoke: endpoint
    .route({
      method: 'POST',
      path: `${path}/{appId}/revoke`,
      summary: 'Revoke an API app',
      description:
        'Stops the app and its token for good. The person the app acts for and people with `apps.manage` can revoke it; when someone else revokes it, the person it acted for is emailed.',
    })
    .meta({ access: anyMember, errors })
    .input(z.object({ params: appParams, headers: command }))
    .output(apiAppSchema),
};
