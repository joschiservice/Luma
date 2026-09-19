import { initServer } from '@ts-rest/fastify';
import type { FastifyRequest } from 'fastify';
import { apiContract, installedConnectionSchema } from '@luma/api-contract';
import { IdentityError } from '#modules/identity/index';
import type { InstallationService } from '#modules/connectors/application/installations';
import type { ShopifyOAuth } from '#modules/connectors/application/shopify';
type ConnectionManagement = Omit<
  InstallationService,
  'credential' | 'recordFailure'
>;

export function connectionRoutes(
  service?: ConnectionManagement,
  shopify?: ShopifyOAuth,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new IdentityError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw new IdentityError(
        503,
        'SERVICE_UNAVAILABLE',
        'Connection service is unavailable',
      );
    return { service, context: request.tenantContext };
  }
  // Parse summaries before serialization so credentials can never become response fields.
  const summary = (value: unknown) => installedConnectionSchema.parse(value);
  return initServer().router(apiContract.connections, {
    shopifyStart: async ({ request, body }) => {
      const { context } = use(request);
      if (!shopify)
        throw new IdentityError(
          503,
          'SERVICE_UNAVAILABLE',
          'Shopify is not configured',
        );
      return { status: 200, body: await shopify.start(context, body) };
    },
    list: async ({ request }) => {
      const { service, context } = use(request);
      return {
        status: 200,
        body: { items: (await service.list(context)).map(summary) },
      };
    },
    install: async ({ request, body }) => {
      const { service, context } = use(request);
      if (shopify && body.target.kind === 'shopify')
        throw new IdentityError(
          422,
          'CONFLICT',
          'Use Connect Shopify to authorize this store',
        );
      return {
        status: 201,
        body: summary(await service.install(context, body)),
      };
    },
    check: async ({ request, params, body }) => {
      const { service, context } = use(request);
      if (
        shopify &&
        (await service.list(context)).some(
          (c) => c.id === params.connectionId && c.target.kind === 'shopify',
        )
      )
        throw new IdentityError(
          422,
          'CONFLICT',
          'Use Reconnect Shopify to validate access',
        );
      return {
        status: 200,
        body: summary(
          await service.check(context, params.connectionId, body.version),
        ),
      };
    },
    rotate: async ({ request, params, body }) => {
      const { service, context } = use(request);
      if (
        shopify &&
        (await service.list(context)).some(
          (c) => c.id === params.connectionId && c.target.kind === 'shopify',
        )
      )
        throw new IdentityError(
          422,
          'CONFLICT',
          'Use Reconnect Shopify to renew access',
        );
      return {
        status: 200,
        body: summary(
          await service.rotate(
            context,
            params.connectionId,
            body.version,
            body.credentials,
          ),
        ),
      };
    },
    disconnect: async ({ request, params, body }) => {
      const { service, context } = use(request);
      return {
        status: 200,
        body: summary(
          await service.disconnect(context, params.connectionId, body.version),
        ),
      };
    },
  });
}
