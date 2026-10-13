import { z } from 'zod';

import { endpoint, organizationParamsSchema, requires } from '../common.js';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const review = z.object({
  id,
  connectionId: id,
  sourceBinding: z.string(),
  connectionVersion: z.number().int(),
  credentialVersion: z.number().int(),
  actorId: z.string(),
  observedAt: timestamp,
  expiresAt: timestamp,
  observations: z
    .array(
      z.object({
        id: z.string(),
        provider: z.string(),
        resource: z.string(),
        sourceRevision: z.string().nullable(),
        observedAt: timestamp,
      }),
    )
    .max(1),
});
const declaration = z.object({
  connectionId: id,
  revision: z.number().int().positive(),
  review: review.nullable(),
  revoked: z.boolean(),
  actorId: z.string(),
  reason: z.string(),
  at: timestamp,
});
const provenance = z
  .object({
    basis: z.enum([
      'reviewed_workspace_declaration',
      'simulation_manifest',
      'unclassified_source',
    ]),
    connectionId: id,
    connectionVersion: z.number().int(),
    credentialVersion: z.number().int(),
    sourceBinding: z.string(),
    declarationRevision: z.number().int().nullable(),
    evidenceId: id.nullable(),
  })
  .nullable();
const params = organizationParamsSchema.extend({ connectionId: id });
const path = '/v1/organizations/{organizationId}/source-environments';
const meta = {
  access: requires('connections.manage'),
  errors: [400, 401, 403, 404, 409, 422, 503] as const,
};

/** Reviewed declarations describe workspace operational use; they never certify a provider or grant writes. */
export const sourceEnvironmentsContract = {
  list: endpoint
    .route({
      method: 'GET',
      path,
      summary: 'Read source environment declarations',
      description:
        'Separates simulator proof, reviewed workspace live declarations and unknown sources. Changed source or credential revisions invalidate a declaration.',
    })
    .meta(meta)
    .input(z.object({ params: organizationParamsSchema }))
    .output(
      z.object({
        available: z.boolean(),
        items: z.array(
          z.object({
            connectionId: id,
            label: z.string(),
            reviewable: z.boolean(),
            reviewBlock: z
              .enum([
                'synthetic',
                'inactive',
                'missing_capability',
                'app_unavailable',
              ])
              .nullable(),
            environment: z.enum(['live', 'synthetic', 'unknown']),
            provenance,
            declaration: declaration.nullable(),
          }),
        ),
      }),
    ),
  inspect: endpoint
    .route({
      method: 'POST',
      path: `${path}/{connectionId}/review`,
      summary: 'Read fresh source evidence',
      description:
        'Reads one purchase-order page through the authenticated connection and retains source identity evidence without record payloads. The review expires in five minutes. Simulator sources cannot be declared live.',
    })
    .meta(meta)
    .input(z.object({ params }))
    .output(review),
  change: endpoint
    .route({
      method: 'POST',
      path: `${path}/{connectionId}`,
      summary: 'Declare live operational use or revoke it',
      description:
        'An authorized person confirms live operational use with a reason and a fresh exact-source review. This is a reviewed workspace declaration, not provider certification. Retry-safe commands retain actor, revision and evidence; previous history never changes classification.',
    })
    .meta(meta)
    .input(
      z.object({
        params,
        body: z
          .object({
            commandId: id,
            expectedRevision: z.number().int().nonnegative(),
            reviewId: id.nullable(),
            liveOperationsConfirmed: z.boolean(),
            reason: z.string().trim().min(1).max(1000),
          })
          .strict(),
      }),
    )
    .output(declaration),
};
