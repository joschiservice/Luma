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

export const apiContract = c.router(
  {
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
