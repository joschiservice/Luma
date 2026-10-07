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

/**
 * Who may call a tenant route. The request guard checks it after resolving the caller's
 * membership and before the handler runs; services still check their own permissions.
 */
export type RouteAccess =
  { permission: string | readonly string[] } | { access: 'member' };

/** Route metadata for any member of the workspace, such as personal settings. */
export const anyMember = { access: 'member' } as const satisfies RouteAccess;

/** Route metadata requiring a permission, or any one of several permissions. */
export function requires<const P extends string | readonly string[]>(
  permission: P,
) {
  return { permission } as const satisfies RouteAccess;
}
