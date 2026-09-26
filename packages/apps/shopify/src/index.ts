import '@luma/identity/http';

import type { AppDefinition, AppFactoryContext } from '@luma/app-host';
import type { ConnectionProvider } from '@luma/connections';
import { simulationTransport } from '@luma/connections/adapters';
import { IdentityError } from '@luma/identity';

import { registerShopifyRoutes } from './api/shopify.js';
import type { ShopifyOAuth } from './application/oauth.js';
import { readShopifyConfig } from './config.js';
import { createShopifyConnector } from './infrastructure/adapter.js';
import {
  installationCredentials,
  installationInput,
  installationTarget,
} from './infrastructure/installation-validation.js';
import { createShopifyOAuth } from './infrastructure/oauth.js';
import { createInstallationVerifier } from './infrastructure/verifier.js';

export {
  createShopifyConnector,
  createShopifyOAuth,
  createInstallationVerifier,
  readShopifyConfig,
  registerShopifyRoutes,
};

export type { ShopifyOAuth };

export type { ShopifyConfig } from './config.js';

export type {
  ShopifyConnectorOptions,
  ShopifyEvidence,
} from './infrastructure/adapter.js';

export { mapShopifyWebhook } from './infrastructure/webhooks.js';

/** Creates Shopify capability, validation, and credential-refresh contributions. */
export function createShopifyProvider(
  options: Parameters<typeof createInstallationVerifier>[0] & {
    oauth?: ShopifyOAuth;
  } = {},
): ConnectionProvider {
  return {
    appId: 'shopify',
    provider: 'shopify',
    targets: ['shopify'],
    recordAccessFailures: true,
    management: options.oauth ? [] : ['check', 'rotate'],
    validate: (value) => installationInput.parse(value),
    credentials: (_target, value) => installationCredentials.parse(value),
    verify: createInstallationVerifier(options),
    ...(options.oauth ? { refreshCredential: options.oauth.credential } : {}),
    manage() {
      if (options.oauth)
        throw new IdentityError(
          422,
          'CONFLICT',
          'Use Connect Shopify to authorize this store',
        );
    },
    async build(context, id, capability, runtime) {
      const current = await runtime.installations.credential(
        context,
        id,
        capability,
      );
      const target = installationTarget.parse(current.connection.target);
      const fetch =
        simulationTransport(current.connection, runtime.simulation) ??
        runtime.fetch;

      return createShopifyConnector({
        tenantId: context.tenantId,
        connectionId: id,
        shop: target.shop,
        accessToken: async () =>
          (await runtime.installations.credential(context, id, capability))
            .credentials.token,
        recordObservations: runtime.recordObservations,
        ...(fetch ? { fetch } : {}),
      });
    },
  };
}

/** Registers Shopify commerce capabilities and installation-gated OAuth routes. */
export function createApp(context: AppFactoryContext): AppDefinition {
  const config = readShopifyConfig(context.env);
  const oauth = config
    ? createShopifyOAuth(context.database, config, {
        cipher: context.cipher,
        refreshContext: context.refreshContext,
        verify: createInstallationVerifier({}),
        requireInstalled: (ctx) => context.requireInstalled(ctx, 'shopify'),
      })
    : undefined;

  return {
    manifest: {
      id: 'shopify',
      name: 'Shopify',
      description:
        'Connect stores to read orders, products, inventory and fulfillment.',
      version: '1.0.0',
      category: 'storefront',
      ui: ['connections', 'settings'],
      connectionTypes: [{ kind: 'shopify', name: 'Shopify' }],
    },
    connector: createShopifyProvider(oauth ? { oauth } : {}),
    async uninstalled({ tenantId, transaction }) {
      if (config)
        await transaction.query(
          'DELETE FROM shopify_oauth_states WHERE tenant_id=$1',
          [tenantId],
        );
    },
    async ready() {
      if (!config) return true;

      return context.database.transaction(
        '00000000-0000-4000-8000-000000000000',
        async (tx) => {
          await tx.query('SELECT digest FROM shopify_oauth_states LIMIT 0');
          await tx.query(
            'SELECT connection_id FROM shopify_installation_bindings LIMIT 0',
          );

          return true;
        },
      );
    },
    registerHttp(server, identity) {
      registerShopifyRoutes(server, oauth, identity);
      server.post(
        '/v1/organizations/:organizationId/apps/shopify/authorize',
        async (request) => {
          if (!request.tenantContext)
            throw new IdentityError(
              401,
              'UNAUTHENTICATED',
              'Sign in to continue',
            );
          await context.requireInstalled(request.tenantContext, 'shopify');
          if (!oauth)
            throw new IdentityError(
              503,
              'SERVICE_UNAVAILABLE',
              'Shopify authorization is not configured',
            );

          return oauth.start(request.tenantContext, request.body);
        },
      );
    },
  };
}
