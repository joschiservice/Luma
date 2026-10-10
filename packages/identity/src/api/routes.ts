import type { RouteAccess } from '@luma/api-contract';
import { apiContract } from '@luma/api-contract';
import { implement } from '@orpc/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { IdentityService } from '../application/identity.js';
import type { TenantContext } from '../domain/context.js';
import { IdentityError } from '../domain/context.js';
import type { HttpContext } from './contract-routes.js';

/** Extracts the cookie and authorization headers used to resolve a request's session. */
export function credentials(request: FastifyRequest) {
  return request.headers.cookie ? { cookie: request.headers.cookie } : {};
}

function tenantContext(request: FastifyRequest) {
  if (!request.tenantContext)
    throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');

  return request.tenantContext;
}

/**
 * Creates organization and membership handlers; returns service unavailable when identity is
 * not configured.
 */
export function identityRoutes(service?: IdentityService) {
  const use = () => {
    if (!service)
      throw new IdentityError(
        503,
        'REGION_UNAVAILABLE',
        'Identity service is unavailable',
      );

    return service;
  };

  const os = implement(apiContract.identity).$context<HttpContext>();

  return os.router({
    listSecurityEvents: os.listSecurityEvents.handler(
      async ({ context: { request }, input: { query } }) =>
        use().listSecurityEvents(credentials(request), query.cursor),
    ),
    listOrganizations: os.listOrganizations.handler(
      async ({ context: { request } }) => ({
        items: await use().listOrganizations(credentials(request)),
      }),
    ),
    createOrganization: os.createOrganization.handler(
      async ({ context: { request }, input: { body } }) =>
        use().createOrganization(credentials(request), body),
    ),
    context: os.context.handler(({ context: { request } }) => {
      const context = tenantContext(request);

      return {
        tenantId: context.tenantId,
        dataRegion: context.dataRegion,
        requestId: context.requestId,
        actor: context.actor,
        permissions: [...context.permissions],
        allAppPermissions: context.permissions.allAppPermissions,
      };
    }),
    listMembers: os.listMembers.handler(async ({ context: { request } }) => ({
      items: await use().listMembers(tenantContext(request)),
    })),
    addMember: os.addMember.handler(
      async ({ context: { request }, input: { headers, body } }) =>
        (await use().changeMember(tenantContext(request), {
          ...commandId(headers),
          action: 'add',
          ...body,
        }))!,
    ),
    updateMember: os.updateMember.handler(
      async ({ context: { request }, input: { params, headers, body } }) =>
        (await use().changeMember(tenantContext(request), {
          ...commandId(headers),
          action: 'update',
          memberId: params.memberId,
          roleId: body.roleId,
        }))!,
    ),
    removeMember: os.removeMember.handler(
      async ({ context: { request }, input: { params, headers } }) => {
        await use().changeMember(tenantContext(request), {
          ...commandId(headers),
          action: 'remove',
          memberId: params.memberId,
        });
      },
    ),
  });
}

function commandId(headers: { 'x-command-id'?: string | undefined }) {
  return headers['x-command-id'] ? { commandId: headers['x-command-id'] } : {};
}

// Deliberate public surface: newly registered routes require tenant authorization.
const publicRoutes = new Set([
  'GET /health',
  'GET /ready',
  'GET /openapi.json',
  'GET /v1/connector-providers',
  'GET /v1/connector-providers/:providerId',
  'GET /auth/*',
  'POST /auth/*',
]);

/** Registers session, organization, and origin guards before protected route handlers run. */
export function registerIdentityGuards(
  app: FastifyInstance,
  service?: IdentityService,
  trustedOrigins: readonly string[] = [],
) {
  app.decorateRequest('tenantContext', null);
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url;
    if (
      !route ||
      request.routeOptions.config.authentication === 'app' ||
      publicRoutes.has(
        `${request.method === 'HEAD' ? 'GET' : request.method} ${route}`,
      )
    )
      return;
    if (!service)
      throw new IdentityError(
        503,
        'REGION_UNAVAILABLE',
        'Identity service is unavailable',
      );
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      (!request.headers.origin ||
        !trustedOrigins.includes(request.headers.origin))
    )
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'A trusted Origin header is required',
      );
    if (
      route === '/v1/organizations' ||
      route === '/v1/account/security-events' ||
      route === '/v1/invitations/preview' ||
      route === '/v1/invitations/accept'
    ) {
      await service.authenticate(credentials(request));

      return;
    }
    const params = request.params as { organizationId?: string };
    if (
      !params.organizationId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        params.organizationId,
      )
    )
      throw new IdentityError(404, 'NOT_FOUND', 'Organization not found');
    const context = await service.resolveTenant(
      credentials(request),
      params.organizationId,
      request.id,
    );
    request.tenantContext = context;
    authorizeRoute(context, routeAccess(request));
  });
}

/** Reads the access a tenant route declares in its contract metadata or route config. */
function routeAccess(request: FastifyRequest): RouteAccess | undefined {
  return request.routeOptions.config.access;
}

/**
 * Denies tenant routes that declare no access, and callers without any one of the declared
 * permissions. App permissions are checked again by the app host with installation state.
 */
function authorizeRoute(
  context: TenantContext,
  access: RouteAccess | undefined,
) {
  if (access && 'access' in access && access.access === 'member') return;
  const permissions =
    access && 'permission' in access
      ? typeof access.permission === 'string'
        ? [access.permission]
        : access.permission
      : [];
  if (!permissions.some((permission) => context.permissions.has(permission)))
    throw new IdentityError(
      403,
      'FORBIDDEN',
      permissions.length
        ? 'Your role does not allow this. Ask a workspace admin for access.'
        : 'This route does not declare who may use it.',
    );
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** App-owned handlers authenticate signed callbacks and webhooks themselves. */
    authentication?: 'app';
    /** Who may call a tenant route; contract routes copy it from their metadata. */
    access?: import('@luma/api-contract').RouteAccess;
  }

  interface FastifyRequest {
    tenantContext: import('../domain/context.js').TenantContext | null;
  }
}
