import { createAppHost } from '@luma/app-catalog';
import { createApp as cin7, createCin7Provider } from '@luma/app-cin7';
import { createApp as gmail, createGmailProvider } from '@luma/app-gmail';
import { createApp as jtl, createJtlProvider } from '@luma/app-jtl';
import { createApp as shopify, createShopifyProvider } from '@luma/app-shopify';
import {
  createApp as starshipit,
  createStarshipitProvider,
} from '@luma/app-starshipit';
import {
  createInstalledRuntime as runtime,
  createInstalledShippingMethodEffects as effects,
} from '@luma/connections/composition';

/**
 * Composes every adapter for local simulator fixtures, in the order of `factories`.
 * `cin7RequestIntervalMs` lowers Cin7 request pacing for a simulator that does not throttle.
 */
function fixtureProviders(options) {
  return [
    createJtlProvider({
      ...options,
      jtlEndpoints: options.jtlEndpoints ?? [],
      purchaseOrderChangesEnabled:
        options.purchaseOrderChangesEnabled ??
        ((tenantId) =>
          options.featureEnabled?.(tenantId, 'purchasing-order-changes') ??
          Promise.resolve(false)),
      purchasingTermsEnabled:
        options.purchasingTermsEnabled ??
        ((tenantId) =>
          options.featureEnabled?.(tenantId, 'supplier-purchasing-terms') ??
          Promise.resolve(false)),
    }),
    createShopifyProvider(options),
    createCin7Provider({
      ...options,
      requestIntervalMs: options.cin7RequestIntervalMs,
      purchasingTermsEnabled:
        options.purchasingTermsEnabled ??
        ((tenantId) =>
          options.featureEnabled?.(tenantId, 'supplier-purchasing-terms') ??
          Promise.resolve(false)),
    }),
    createStarshipitProvider(options),
    // Token-based mailbox access through the simulator; no Google OAuth or push in fixtures.
    createGmailProvider({
      ...(options.simulation ? { simulation: options.simulation } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  ];
}

/** Verifies fixture accounts through the provider that owns their target. */
export function createInstallationVerifier(options) {
  const providers = fixtureProviders(options);

  return (connection, credentials) =>
    providers
      .find((p) => p.targets.includes(connection.target.kind))
      .verify(connection, credentials);
}

/** Creates a real app lifecycle around local synthetic provider transports. */
export function createInstalledConnections(db, options) {
  const providers = fixtureProviders(options);
  const host = createAppHost(db, {
    ...options,
    env: options.env ?? {},
    factories: [jtl, shopify, cin7, starshipit, gmail].map(
      (factory, index) => (context) => {
        const definition = factory(context);

        return {
          ...definition,
          connector: {
            ...(factory === shopify
              ? createShopifyProvider({
                  ...options,
                  requestBudgetStore: context.requestBudgetStore,
                  env: context.env,
                })
              : factory === starshipit
                ? definition.connector
                : providers[index]),
            ...(options.verify && factory !== shopify
              ? { verify: options.verify }
              : {}),
          },
        };
      },
    ),
  });

  return {
    ...host.connections,
    // The host shape `applicationOptionsFor` derives runtime options from.
    connections: host.connections,
    close: host.close,
    apps: host.apps,
    registry: host.registry,
    decisionSources: host.decisionSources,
    providerCatalog: host.providerCatalog,
    connectionEnvironment: host.connectionEnvironment,
    sourceEnvironments: host.sourceEnvironments,
  };
}

/** Builds a simulator capability runtime with explicit provider contributions. */
export function createInstalledRuntime(options) {
  return runtime({
    ...options,
    providers: options.providers ?? fixtureProviders(options),
  });
}

/** Builds simulator effects with explicit provider contributions. */
export function createInstalledShippingMethodEffects(options, binding) {
  return effects(
    { ...options, providers: options.providers ?? fixtureProviders(options) },
    binding,
  );
}
