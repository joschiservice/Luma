import { z } from 'zod';

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
    'SERVICE_UNAVAILABLE',
    'NOT_READY',
    'INTERNAL_ERROR',
    'PAYLOAD_TOO_LARGE',
    'TOO_MANY_REQUESTS',
    'UNSUPPORTED_MEDIA_TYPE',
  ]),
  message: z.string(),
  requestId: z.string(),
});

export const caseParams = organizationParamsSchema.extend({
  exceptionId: z.string().uuid(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
