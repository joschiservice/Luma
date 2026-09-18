import { initContract } from '@ts-rest/core';
import { z } from 'zod';

const c = initContract();

export const dataRegionSchema = z.enum(['EU', 'US', 'APAC']);
export const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});
export const apiErrorSchema = z.object({
  code: z.enum([
    'VALIDATION_ERROR',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'REGION_UNAVAILABLE',
    'NOT_READY',
    'INTERNAL_ERROR',
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
  ]),
  message: z.string(),
  requestId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const connectorProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  category: z.enum(['storefront', 'erp']),
});
export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export const organizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  dataRegion: dataRegionSchema,
  status: z.enum(['active', 'suspended', 'closed']),
});
export const membershipSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: roleSchema,
});
export const tenantContextSchema = z.object({
  tenantId: z.string().uuid(),
  dataRegion: z.literal('EU'),
  requestId: z.string(),
  actor: z.object({
    type: z.literal('user'),
    id: z.string().uuid(),
    initiatingUserId: z.string().uuid(),
    sessionId: z.string().uuid(),
    membershipId: z.string().uuid(),
    role: roleSchema,
  }),
});
const memberParamsSchema = organizationParamsSchema.extend({
  memberId: z.string().uuid(),
});
const identityContract = c.router(
  {
    listOrganizations: {
      method: 'GET',
      path: '/v1/organizations',
      responses: { 200: z.object({ items: z.array(organizationSchema) }) },
      summary: 'List your organizations',
    },
    createOrganization: {
      method: 'POST',
      path: '/v1/organizations',
      body: z
        .object({
          name: z.string().trim().min(1).max(200),
          slug: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          dataRegion: dataRegionSchema.optional(),
        })
        .strict(),
      responses: { 201: organizationSchema, 422: apiErrorSchema },
      summary: 'Create an organization',
      description:
        'Creates an EU organization with you as its owner. Other regions are unavailable.',
    },
    context: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/context',
      pathParams: organizationParamsSchema,
      responses: { 200: tenantContextSchema },
      summary: 'Resolve your organization access',
    },
    listMembers: {
      method: 'GET',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      responses: { 200: z.object({ items: z.array(membershipSchema) }) },
      summary: 'List organization members',
    },
    addMember: {
      method: 'POST',
      path: '/v1/organizations/:organizationId/members',
      pathParams: organizationParamsSchema,
      body: z.object({ userId: z.string().uuid(), role: roleSchema }).strict(),
      responses: { 201: membershipSchema },
      summary: 'Add a registered user to an organization',
      description:
        'Owners and admins can add users. Only owners can grant ownership.',
    },
    updateMember: {
      method: 'PATCH',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: z.object({ role: roleSchema }).strict(),
      responses: { 200: membershipSchema },
      summary: 'Change a member role',
    },
    removeMember: {
      method: 'DELETE',
      path: '/v1/organizations/:organizationId/members/:memberId',
      pathParams: memberParamsSchema,
      body: c.noBody(),
      responses: { 204: c.noBody() },
      summary: 'Remove an organization member',
      description: 'The last owner cannot be removed or demoted.',
    },
  },
  {
    commonResponses: {
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
);

export const apiContract = c.router(
  {
    identity: identityContract,
    system: {
      health: {
        method: 'GET',
        path: '/health',
        responses: { 200: z.object({ status: z.literal('ok') }) },
        summary: 'Check whether the API is running',
      },
      ready: {
        method: 'GET',
        path: '/ready',
        responses: {
          200: z.object({ status: z.literal('ready') }),
          503: apiErrorSchema,
        },
        summary: 'Check whether the API is ready to serve requests',
        description:
          'Returns 200 when ready and 503 when temporarily unavailable.',
      },
    },
    connectorProviders: c.router(
      {
        list: {
          method: 'GET',
          path: '/connector-providers',
          query: z
            .object({ category: z.enum(['storefront', 'erp']).optional() })
            .strict(),
          responses: {
            200: z.object({ items: z.array(connectorProviderSchema) }),
          },
          summary: 'List connector providers',
          description:
            'Browse provider names and categories. Filter by storefront or ERP.',
        },
        get: {
          method: 'GET',
          path: '/connector-providers/:providerId',
          pathParams: z.object({
            providerId: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z][a-z0-9-]*$/),
          }),
          responses: { 200: connectorProviderSchema, 404: apiErrorSchema },
          summary: 'Get a connector provider',
          description:
            'Look up a provider by its ID. Returns 404 if the provider is not in the catalog.',
        },
      },
      { pathPrefix: '/v1' },
    ),
  },
  {
    strictStatusCodes: true,
    commonResponses: {
      400: apiErrorSchema,
      413: apiErrorSchema,
      415: apiErrorSchema,
      500: apiErrorSchema,
    },
  },
);
export { diagnosisSchema } from './diagnosis.js';
export type { Diagnosis } from './diagnosis.js';
