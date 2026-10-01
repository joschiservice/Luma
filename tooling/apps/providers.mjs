import { createAppHost } from '@luma/app-catalog';
import { createApp as jtl, createJtlProvider } from '@luma/app-jtl';
import { createApp as shopify, createShopifyProvider } from '@luma/app-shopify';
import {
  createInstalledPurchaseOrderRuntime as purchaseOrders,
  createInstalledRuntime as runtime,
  createInstalledShippingMethodEffects as effects,
} from '@luma/connections/composition';

/** Composes both adapters for local simulator fixtures. */
export function fixtureProviders(options) {
  return [
    createJtlProvider({ ...options, jtlEndpoints: options.jtlEndpoints ?? [] }),
    createShopifyProvider(options),
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
    env: {},
    factories: [jtl, shopify].map((factory, index) => (context) => {
      const definition = factory(context);

      return {
        ...definition,
        connector: {
          ...providers[index],
          ...(options.verify ? { verify: options.verify } : {}),
        },
      };
    }),
  });

  return {
    ...host.connections,
    apps: host.apps,
    registry: host.registry,
    providerCatalog: host.providerCatalog,
  };
}

/** Builds a simulator capability runtime with explicit provider contributions. */
export function createInstalledRuntime(options) {
  return runtime({ ...options, providers: fixtureProviders(options) });
}

/** Builds simulator effects with explicit provider contributions. */
export function createInstalledShippingMethodEffects(options, binding) {
  return effects({ ...options, providers: fixtureProviders(options) }, binding);
}

/** Builds simulator purchase-order reads and submission effects with explicit providers. */
export function createInstalledPurchaseOrderRuntime(options) {
  return purchaseOrders({ ...options, providers: fixtureProviders(options) });
}
