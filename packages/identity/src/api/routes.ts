import type { RouteAccess } from '@luma/api-contract';
import { apiContract } from '@luma/api-contract';
import { implement } from '@orpc/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { IdentityService } from '../application/identity.js';
import type { TenantContext } from '../domain/context.js';
import { IdentityError, ReadOnlyAccessError } from '../domain/context.js';
import type { HttpContext } from './contract-routes.js';
import { restrictRequestToReads, runInRequestScope } from './request-scope.js';

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
    supportView: os.supportView.handler(
      async ({ context: { request, reply } }) => {
        const state = await use().supportView(credentials(request), request.id);
        // A view that ended no longer selects anything; drop its cookie.
        if (!state.active && use().hasSupportView(credentials(request)))
          reply.header(
            'set-cookie',
            await use().endSupportView(credentials(request), request.id),
          );

        return state;
      },
    ),
    redeemSupportView: os.redeemSupportView.handler(
      async ({ context: { request, reply }, input: { body } }) => {
        const view = await use().redeemSupportView(body.token, request.id);
        reply.header('set-cookie', view.cookie);
        reply.header('referrer-policy', 'no-referrer');

        return { workspaceId: view.workspaceId };
      },
    ),
    endSupportView: os.endSupportView.handler(
      async ({ context: { request, reply } }) => {
        reply.header(
          'set-cookie',
          await use().endSupportView(credentials(request), request.id),
        );
      },
    ),
    listSecurityEvents: os.listSecurityEvents.handler(
      async ({ context: { request }, input: { query } }) =>
        use().listSecurityEvents(credentials(request), query.cursor),
    ),
    listSupportInspections: os.listSupportInspections.handler(
      async ({ context: { request } }) =>
        use().supportInspections(credentials(request)),
    ),
    decideSupportInspection: os.decideSupportInspection.handler(
      async ({ context: { request }, input: { params, body } }) =>
        use().decideSupportInspection(
          credentials(request),
          params.requestId,
          body.decision,
          request.id,
        ),
    ),
    revokeSupportInspection: os.revokeSupportInspection.handler(
      async ({ context: { request }, input: { params } }) =>
        use().revokeSupportInspection(
          credentials(request),
          params.requestId,
          request.id,
        ),
    ),
    setLanguage: os.setLanguage.handler(
      async ({ context: { request }, input: { body } }) => {
        await use().setLanguage(credentials(request), body.language);
      },
    ),
    listOrganizations: os.listOrganizations.handler(
      async ({ context: { request } }) => ({
        items: await use().listOrganizations(credentials(request), request.id),
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
        supportView: context.supportView ?? null,
      };
    }),
    listMembers: os.listMembers.handler(async ({ context: { request } }) => ({
      items: await use().listMembers(tenantContext(request)),
    })),
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
  'GET /auth/region-config',
  'GET /auth/*',
  'POST /auth/*',
]);

// Support view handlers read the support cookie themselves; mutations still need a trusted Origin.
const supportViewRoutes = new Set([
  'GET /v1/support-view',
  'POST /v1/support-view/redeem',
  'POST /v1/support-view/end',
]);

// Routes for the signed-in account rather than one workspace.
const accountRoutes = new Set([
  '/v1/organizations',
  '/v1/account/security-events',
  '/v1/account/support-inspections',
  '/v1/account/support-inspections/:requestId',
  '/v1/account/support-inspections/:requestId/revoke',
  '/v1/account/language',
  '/v1/invitations/preview',
  '/v1/invitations/accept',
]);

/**
 * Registers session, organization, and origin guards before protected route handlers run. In a
 * support view, routes other than `GET`, `HEAD` and those declaring `readOnly` are refused before
 * access is resolved, and the rest of the request is restricted to reads.
 */
export function registerIdentityGuards(
  app: FastifyInstance,
  service?: IdentityService,
  trustedOrigins: readonly string[] = [],
) {
  app.decorateRequest('tenantContext', null);
  // Every request gets a scope that a support view can restrict to reads.
  app.addHook('onRequest', (_request, _reply, done) => runInRequestScope(done));
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url;
    const key = `${request.method === 'HEAD' ? 'GET' : request.method} ${route}`;
    if (
      !route ||
      request.routeOptions.config.authentication === 'app' ||
      publicRoutes.has(key)
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
    if (supportViewRoutes.has(key)) return;
    const supportView = service.hasSupportView(credentials(request));
    if (accountRoutes.has(route)) {
      // The support view lists only its own workspace; other account routes are personal.
      if (supportView && key === 'GET /v1/organizations') return;
      if (supportView)
        throw new IdentityError(
          403,
          'READ_ONLY',
          'This isn’t available in a Luma support view.',
        );
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
    if (supportView && !readsOnly(request)) throw new ReadOnlyAccessError();
    const context = await service.resolveTenant(
      credentials(request),
      params.organizationId,
      request.id,
      { supportView: { read: null } },
    );
    request.tenantContext = context;
    if (context.supportView) restrictRequestToReads();
    authorizeRoute(context, routeAccess(request));
    // Record the read only once it is allowed, so the evidence lists what staff actually saw.
    if (context.supportView)
      await service.resolveTenant(
        credentials(request),
        params.organizationId,
        request.id,
        { supportView: { read: request.url.split('?')[0] ?? route } },
      );
  });
}

/** Reports whether a route only reads: `GET`, `HEAD`, or declared `readOnly`. */
function readsOnly(request: FastifyRequest) {
  return (
    request.method === 'GET' ||
    request.method === 'HEAD' ||
    request.routeOptions.config.readOnly === true
  );
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
    /** A route with a request body that only reads; support views may call it. */
    readOnly?: true;
  }

  interface FastifyRequest {
    tenantContext: import('../domain/context.js').TenantContext | null;
  }
}
