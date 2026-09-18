import { initServer } from '@ts-rest/fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { apiContract } from '@luma/api-contract';
import type { IdentityService } from '#modules/identity/application/identity';
import { IdentityError } from '#modules/identity/domain/context';
export function credentials(request: FastifyRequest) {
  return request.headers.cookie ? { cookie: request.headers.cookie } : {};
}
function tenantContext(request: FastifyRequest) {
  if (!request.tenantContext)
    throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  return request.tenantContext;
}
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
  return initServer().router(apiContract.identity, {
    listOrganizations: async ({ request }) => ({
      status: 200,
      body: { items: await use().listOrganizations(credentials(request)) },
    }),
    createOrganization: async ({ request, body }) => ({
      status: 201,
      body: await use().createOrganization(credentials(request), body),
    }),
    context: async ({ request }) => ({
      status: 200,
      body: tenantContext(request),
    }),
    listMembers: async ({ request }) => ({
      status: 200,
      body: {
        items: await use().listMembers(tenantContext(request)),
      },
    }),
    addMember: async ({ request, body }) => {
      const member = await use().changeMember(tenantContext(request), {
        action: 'add',
        ...body,
      });
      return { status: 201, body: member! };
    },
    updateMember: async ({ request, params, body }) => {
      const member = await use().changeMember(tenantContext(request), {
        action: 'update',
        memberId: params.memberId,
        role: body.role,
      });
      return { status: 200, body: member! };
    },
    removeMember: async ({ request, params }) => {
      await use().changeMember(tenantContext(request), {
        action: 'remove',
        memberId: params.memberId,
      });
      return { status: 204, body: undefined };
    },
  });
}
// Deliberate public surface: newly registered routes require tenant authorization.
const publicRoutes = new Set([
  'GET /v1/shopify/callback',
  'POST /v1/shopify/uninstall/:organizationId/:connectionId',
  'GET /health',
  'GET /ready',
  'GET /openapi.json',
  'GET /v1/connector-providers',
  'GET /v1/connector-providers/:providerId',
  'GET /auth/*',
  'POST /auth/*',
]);
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
    if (route === '/v1/organizations') {
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
    request.tenantContext = await service.resolveTenant(
      credentials(request),
      params.organizationId,
      request.id,
    );
  });
}
declare module 'fastify' {
  interface FastifyRequest {
    tenantContext:
      import('#modules/identity/domain/context').TenantContext | null;
  }
}
