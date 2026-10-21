import { oc } from '@orpc/contract';
import { z } from 'zod';

export const dataRegionSchema = z.enum(['EU', 'AU', 'US']);

export const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

export const apiErrorSchema = z.object({
  code: z.enum([
    'VALIDATION_ERROR',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'ACCESS_SUSPENDED',
    'EMAIL_NOT_VERIFIED',
    'READ_ONLY',
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

/** Error statuses a route documents; every route also documents 400, 413, 415 and 500. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503;

/** Route metadata read by the identity guard and the OpenAPI document. */
export interface RouteMeta {
  access?: RouteAccess;
  errors?: readonly ErrorStatus[];
  /**
   * Marks a route with a request body that only reads, so read-only support views may call it.
   * `GET` routes are reads already; every other route is refused in a support view.
   */
  readOnly?: true;
  /**
   * Marks a route as part of the public API: personal API apps may call it with a bearer token,
   * and it is listed in the public API document. Every other route needs a signed-in person.
   * Public routes keep their shape within `/v1`; see the API guide's contract rules.
   */
  publicApi?: true;
  /**
   * The route's response can include customer personal data when the caller holds
   * `customers.read`. API app reads of it are counted and recorded in workspace activity.
   */
  personalData?: true;
}

/**
 * Starts a REST route. Handlers and clients receive `params`, `query`, `headers` and `body`
 * separately; declare each part the route accepts in its input object.
 */
export const endpoint = oc
  .$meta<RouteMeta>({})
  .$route({ inputStructure: 'detailed' });
